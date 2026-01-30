/**
 * LUNARA Backend API
 * Cloudflare Workers + D1 + KV + Stripe
 * 
 * This is the main API worker that handles:
 * - Authentication (register, login, verify email, reset password)
 * - User accounts and sessions
 * - LUNARA Points system (earn, spend, tiers)
 * - Orders and checkout via Stripe
 * - Webhook handling for Stripe events
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import Stripe from 'stripe';

// ============================================================================
// TYPES
// ============================================================================

interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  JWT_SECRET: string;
  BREVO_API_KEY?: string;
  SITE_URL: string;
}

interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  points_balance: number;
  tier: string;
  created_at: string;
  verified_at: string | null;
  verification_token: string | null;
  reset_token: string | null;
  reset_token_expires: string | null;
}

interface Session {
  userId: string;
  email: string;
  name: string | null;
  tier: string;
  createdAt: number;
  expiresAt: number;
}

interface CartItem {
  productId: number;
  variant: { size: string; color: string };
  quantity: number;
  price: number;
  name: string;
}

// ============================================================================
// LUNARA POINTS CONFIGURATION
// ============================================================================

const POINTS_CONFIG = {
  // Earn rates
  EARN_PER_EURO: 1, // 1 point per 1€ spent
  SIGNUP_BONUS: 50,
  NEWSLETTER_BONUS: 25,
  REVIEW_BONUS: 100,
  
  // Spend rates
  POINTS_PER_EURO_DISCOUNT: 20, // 20 points = 1€ discount
  MAX_DISCOUNT_PERCENT: 20, // Max 20% of cart
  MIN_ORDER_FOR_REDEMPTION: 30, // Min 30€ to redeem
  
  // Tiers
  TIERS: [
    { name: 'MOON', min: 0, max: 499, bonusMultiplier: 1.0 },
    { name: 'ECLIPSE', min: 500, max: 1499, bonusMultiplier: 1.1 },
    { name: 'NOVA', min: 1500, max: Infinity, bonusMultiplier: 1.25 }
  ]
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function generateToken(length = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const inputHash = await hashPassword(password);
  return inputHash === hash;
}

function getTier(points: number): typeof POINTS_CONFIG.TIERS[0] {
  return POINTS_CONFIG.TIERS.find(t => points >= t.min && points <= t.max) || POINTS_CONFIG.TIERS[0];
}

function calculatePointsEarned(amountCents: number, tier: typeof POINTS_CONFIG.TIERS[0]): number {
  const euros = amountCents / 100;
  const basePoints = Math.floor(euros * POINTS_CONFIG.EARN_PER_EURO);
  return Math.floor(basePoints * tier.bonusMultiplier);
}

function calculateMaxDiscount(cartTotalCents: number, pointsBalance: number): { maxPoints: number; maxDiscountCents: number } {
  const maxByPercent = Math.floor(cartTotalCents * (POINTS_CONFIG.MAX_DISCOUNT_PERCENT / 100));
  const maxByBalance = Math.floor(pointsBalance / POINTS_CONFIG.POINTS_PER_EURO_DISCOUNT) * 100;
  const maxDiscountCents = Math.min(maxByPercent, maxByBalance);
  const maxPoints = Math.floor(maxDiscountCents / 100 * POINTS_CONFIG.POINTS_PER_EURO_DISCOUNT);
  return { maxPoints, maxDiscountCents };
}

// ============================================================================
// APP SETUP
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Session middleware
async function getSession(c: any): Promise<Session | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  
  const token = authHeader.slice(7);
  const sessionData = await c.env.SESSIONS.get(token);
  if (!sessionData) return null;
  
  const session: Session = JSON.parse(sessionData);
  if (Date.now() > session.expiresAt) {
    await c.env.SESSIONS.delete(token);
    return null;
  }
  
  return session;
}

// ============================================================================
// AUTH ROUTES
// ============================================================================

// Register
app.post('/api/auth/register', async (c) => {
  try {
    const { email, password, name } = await c.req.json();
    
    if (!email || !password) {
      return c.json({ error: 'E-Mail und Passwort erforderlich' }, 400);
    }
    
    if (password.length < 8) {
      return c.json({ error: 'Passwort muss mindestens 8 Zeichen haben' }, 400);
    }
    
    // Check if user exists
    const existing = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email.toLowerCase()).first();
    
    if (existing) {
      return c.json({ error: 'E-Mail bereits registriert' }, 400);
    }
    
    const userId = generateId();
    const passwordHash = await hashPassword(password);
    const verificationToken = generateToken();
    
    // Create user
    await c.env.DB.prepare(`
      INSERT INTO users (id, email, name, password_hash, points_balance, tier, verification_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      userId,
      email.toLowerCase(),
      name || null,
      passwordHash,
      POINTS_CONFIG.SIGNUP_BONUS,
      'MOON',
      verificationToken
    ).run();
    
    // Log signup bonus
    await c.env.DB.prepare(`
      INSERT INTO points_transactions (id, user_id, amount, type, source, created_at)
      VALUES (?, ?, ?, 'EARN', 'SIGNUP', datetime('now'))
    `).bind(generateId(), userId, POINTS_CONFIG.SIGNUP_BONUS).run();
    
    // TODO: Send verification email via Brevo
    // For now, auto-verify in development
    await c.env.DB.prepare(
      "UPDATE users SET verified_at = datetime('now'), verification_token = NULL WHERE id = ?"
    ).bind(userId).run();
    
    // Create session
    const sessionToken = generateToken(48);
    const session: Session = {
      userId,
      email: email.toLowerCase(),
      name: name || null,
      tier: 'MOON',
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    };
    
    await c.env.SESSIONS.put(sessionToken, JSON.stringify(session), {
      expirationTtl: 7 * 24 * 60 * 60
    });
    
    return c.json({
      success: true,
      token: sessionToken,
      user: {
        id: userId,
        email: email.toLowerCase(),
        name: name || null,
        points: POINTS_CONFIG.SIGNUP_BONUS,
        tier: 'MOON'
      },
      message: `Willkommen bei LUNARA! Du hast ${POINTS_CONFIG.SIGNUP_BONUS} Willkommenspunkte erhalten.`
    });
    
  } catch (error) {
    console.error('Register error:', error);
    return c.json({ error: 'Registrierung fehlgeschlagen' }, 500);
  }
});

// Login
app.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    
    if (!email || !password) {
      return c.json({ error: 'E-Mail und Passwort erforderlich' }, 400);
    }
    
    const user = await c.env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email.toLowerCase()).first<User>();
    
    if (!user) {
      return c.json({ error: 'Ungültige Anmeldedaten' }, 401);
    }
    
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return c.json({ error: 'Ungültige Anmeldedaten' }, 401);
    }
    
    if (!user.verified_at) {
      return c.json({ error: 'Bitte bestätige zuerst deine E-Mail-Adresse' }, 401);
    }
    
    // Create session
    const sessionToken = generateToken(48);
    const session: Session = {
      userId: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
    };
    
    await c.env.SESSIONS.put(sessionToken, JSON.stringify(session), {
      expirationTtl: 7 * 24 * 60 * 60
    });
    
    return c.json({
      success: true,
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        points: user.points_balance,
        tier: user.tier
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Login fehlgeschlagen' }, 500);
  }
});

// Logout
app.post('/api/auth/logout', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    await c.env.SESSIONS.delete(token);
  }
  return c.json({ success: true });
});

// Get current user
app.get('/api/auth/me', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, points_balance, tier, created_at FROM users WHERE id = ?'
  ).bind(session.userId).first<User>();
  
  if (!user) {
    return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  }
  
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      points: user.points_balance,
      tier: user.tier,
      memberSince: user.created_at
    }
  });
});

// ============================================================================
// POINTS ROUTES
// ============================================================================

// Get points balance and tier info
app.get('/api/points', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  const user = await c.env.DB.prepare(
    'SELECT points_balance, tier FROM users WHERE id = ?'
  ).bind(session.userId).first<User>();
  
  if (!user) {
    return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  }
  
  const currentTier = getTier(user.points_balance);
  const nextTier = POINTS_CONFIG.TIERS.find(t => t.min > user.points_balance);
  
  return c.json({
    points: user.points_balance,
    tier: currentTier.name,
    tierInfo: {
      current: currentTier,
      next: nextTier || null,
      pointsToNext: nextTier ? nextTier.min - user.points_balance : 0
    },
    config: {
      earnPerEuro: POINTS_CONFIG.EARN_PER_EURO,
      pointsPerEuroDiscount: POINTS_CONFIG.POINTS_PER_EURO_DISCOUNT,
      maxDiscountPercent: POINTS_CONFIG.MAX_DISCOUNT_PERCENT,
      minOrderForRedemption: POINTS_CONFIG.MIN_ORDER_FOR_REDEMPTION
    }
  });
});

// Get points history
app.get('/api/points/history', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  const transactions = await c.env.DB.prepare(`
    SELECT * FROM points_transactions 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).bind(session.userId).all();
  
  return c.json({ transactions: transactions.results });
});

// Calculate discount for cart
app.post('/api/points/calculate-discount', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  const { cartTotalCents, pointsToUse } = await c.req.json();
  
  const user = await c.env.DB.prepare(
    'SELECT points_balance FROM users WHERE id = ?'
  ).bind(session.userId).first<User>();
  
  if (!user) {
    return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  }
  
  if (cartTotalCents < POINTS_CONFIG.MIN_ORDER_FOR_REDEMPTION * 100) {
    return c.json({
      error: `Mindestbestellwert von ${POINTS_CONFIG.MIN_ORDER_FOR_REDEMPTION}€ für Punkteeinlösung erforderlich`,
      canRedeem: false
    }, 400);
  }
  
  const { maxPoints, maxDiscountCents } = calculateMaxDiscount(cartTotalCents, user.points_balance);
  const actualPointsToUse = Math.min(pointsToUse || maxPoints, maxPoints);
  const discountCents = Math.floor(actualPointsToUse / POINTS_CONFIG.POINTS_PER_EURO_DISCOUNT) * 100;
  
  return c.json({
    pointsAvailable: user.points_balance,
    maxPointsUsable: maxPoints,
    maxDiscountCents,
    pointsToUse: actualPointsToUse,
    discountCents,
    newTotal: cartTotalCents - discountCents
  });
});

// ============================================================================
// CHECKOUT / STRIPE ROUTES
// ============================================================================

// Create Stripe checkout session
app.post('/api/checkout/create-session', async (c) => {
  try {
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
    const session = await getSession(c);
    
    const { items, pointsToRedeem } = await c.req.json() as { 
      items: CartItem[]; 
      pointsToRedeem?: number;
    };
    
    if (!items || items.length === 0) {
      return c.json({ error: 'Warenkorb ist leer' }, 400);
    }
    
    // Calculate totals
    let subtotalCents = 0;
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    
    for (const item of items) {
      const itemTotalCents = Math.round(item.price * 100) * item.quantity;
      subtotalCents += itemTotalCents;
      
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name,
            description: `${item.variant.size} / ${item.variant.color}`,
          },
          unit_amount: Math.round(item.price * 100),
        },
        quantity: item.quantity,
      });
    }
    
    let discountCents = 0;
    let actualPointsUsed = 0;
    
    // Handle points redemption if user is logged in
    if (session && pointsToRedeem && pointsToRedeem > 0) {
      const user = await c.env.DB.prepare(
        'SELECT points_balance FROM users WHERE id = ?'
      ).bind(session.userId).first<User>();
      
      if (user && subtotalCents >= POINTS_CONFIG.MIN_ORDER_FOR_REDEMPTION * 100) {
        const { maxPoints, maxDiscountCents } = calculateMaxDiscount(subtotalCents, user.points_balance);
        actualPointsUsed = Math.min(pointsToRedeem, maxPoints);
        discountCents = Math.floor(actualPointsUsed / POINTS_CONFIG.POINTS_PER_EURO_DISCOUNT) * 100;
        
        if (discountCents > 0) {
          lineItems.push({
            price_data: {
              currency: 'eur',
              product_data: {
                name: 'LUNARA Punkte-Rabatt',
                description: `${actualPointsUsed} Punkte eingelöst`,
              },
              unit_amount: -discountCents,
            },
            quantity: 1,
          });
        }
      }
    }
    
    // Create order in database
    const orderId = generateId();
    const finalTotalCents = subtotalCents - discountCents;
    
    await c.env.DB.prepare(`
      INSERT INTO orders (id, user_id, status, subtotal, discount, points_used, total, items_json, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      orderId,
      session?.userId || null,
      subtotalCents,
      discountCents,
      actualPointsUsed,
      finalTotalCents,
      JSON.stringify(items)
    ).run();
    
    // Create Stripe session
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems.filter(li => (li.price_data?.unit_amount || 0) > 0), // Stripe doesn't allow negative line items
      mode: 'payment',
      success_url: `${c.env.SITE_URL}/checkout-success.html?order=${orderId}`,
      cancel_url: `${c.env.SITE_URL}/checkout.html?cancelled=true`,
      customer_email: session?.email,
      metadata: {
        orderId,
        userId: session?.userId || '',
        pointsUsed: actualPointsUsed.toString(),
        discountCents: discountCents.toString(),
      },
      ...(discountCents > 0 && {
        discounts: [{
          coupon: await getOrCreatePointsCoupon(stripe, discountCents),
        }],
      }),
    });
    
    // Update order with Stripe session ID
    await c.env.DB.prepare(
      'UPDATE orders SET stripe_session_id = ? WHERE id = ?'
    ).bind(checkoutSession.id, orderId).run();
    
    return c.json({
      sessionId: checkoutSession.id,
      url: checkoutSession.url,
      orderId,
    });
    
  } catch (error) {
    console.error('Checkout error:', error);
    return c.json({ error: 'Checkout fehlgeschlagen' }, 500);
  }
});

// Helper to create dynamic coupon for points discount
async function getOrCreatePointsCoupon(stripe: Stripe, amountCents: number): Promise<string> {
  const couponId = `lunara_points_${amountCents}`;
  
  try {
    await stripe.coupons.retrieve(couponId);
    return couponId;
  } catch {
    const coupon = await stripe.coupons.create({
      id: couponId,
      amount_off: amountCents,
      currency: 'eur',
      name: `LUNARA Punkte-Rabatt (${(amountCents / 100).toFixed(2)}€)`,
      duration: 'once',
    });
    return coupon.id;
  }
}

// Stripe webhook handler
app.post('/api/webhooks/stripe', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
  const signature = c.req.header('stripe-signature');
  
  if (!signature) {
    return c.json({ error: 'Missing signature' }, 400);
  }
  
  try {
    const body = await c.req.text();
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const { orderId, userId, pointsUsed, discountCents } = session.metadata || {};
      
      if (orderId) {
        // Update order status
        await c.env.DB.prepare(
          "UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?"
        ).bind(orderId).run();
        
        // Get order details
        const order = await c.env.DB.prepare(
          'SELECT * FROM orders WHERE id = ?'
        ).bind(orderId).first<any>();
        
        if (userId && order) {
          // Deduct points used
          const pointsUsedNum = parseInt(pointsUsed || '0');
          if (pointsUsedNum > 0) {
            await c.env.DB.prepare(
              'UPDATE users SET points_balance = points_balance - ? WHERE id = ?'
            ).bind(pointsUsedNum, userId).run();
            
            await c.env.DB.prepare(`
              INSERT INTO points_transactions (id, user_id, amount, type, source, reference_id, created_at)
              VALUES (?, ?, ?, 'SPEND', 'ORDER', ?, datetime('now'))
            `).bind(generateId(), userId, -pointsUsedNum, orderId).run();
          }
          
          // Award points for purchase
          const user = await c.env.DB.prepare(
            'SELECT points_balance, tier FROM users WHERE id = ?'
          ).bind(userId).first<User>();
          
          if (user) {
            const tier = getTier(user.points_balance);
            const pointsEarned = calculatePointsEarned(order.total, tier);
            
            await c.env.DB.prepare(
              'UPDATE users SET points_balance = points_balance + ? WHERE id = ?'
            ).bind(pointsEarned, userId).run();
            
            await c.env.DB.prepare(`
              INSERT INTO points_transactions (id, user_id, amount, type, source, reference_id, created_at)
              VALUES (?, ?, ?, 'EARN', 'ORDER', ?, datetime('now'))
            `).bind(generateId(), userId, pointsEarned, orderId).run();
            
            // Update order with points earned
            await c.env.DB.prepare(
              'UPDATE orders SET points_earned = ? WHERE id = ?'
            ).bind(pointsEarned, orderId).run();
            
            // Check and update tier
            const newPoints = user.points_balance - pointsUsedNum + pointsEarned;
            const newTier = getTier(newPoints);
            if (newTier.name !== user.tier) {
              await c.env.DB.prepare(
                'UPDATE users SET tier = ? WHERE id = ?'
              ).bind(newTier.name, userId).run();
            }
          }
        }
      }
    }
    
    return c.json({ received: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({ error: 'Webhook processing failed' }, 400);
  }
});

// Get order details
app.get('/api/orders/:id', async (c) => {
  const orderId = c.req.param('id');
  const session = await getSession(c);
  
  const order = await c.env.DB.prepare(
    'SELECT * FROM orders WHERE id = ?'
  ).bind(orderId).first<any>();
  
  if (!order) {
    return c.json({ error: 'Bestellung nicht gefunden' }, 404);
  }
  
  // Only allow viewing own orders if logged in
  if (order.user_id && session?.userId !== order.user_id) {
    return c.json({ error: 'Keine Berechtigung' }, 403);
  }
  
  return c.json({
    order: {
      id: order.id,
      status: order.status,
      subtotal: order.subtotal / 100,
      discount: order.discount / 100,
      pointsUsed: order.points_used,
      pointsEarned: order.points_earned,
      total: order.total / 100,
      items: JSON.parse(order.items_json || '[]'),
      createdAt: order.created_at,
      paidAt: order.paid_at,
    }
  });
});

// Get user's order history
app.get('/api/orders', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  const orders = await c.env.DB.prepare(`
    SELECT id, status, total, points_earned, items_json, created_at, paid_at
    FROM orders 
    WHERE user_id = ? 
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(session.userId).all();
  
  return c.json({
    orders: orders.results?.map((o: any) => ({
      id: o.id,
      status: o.status,
      total: o.total / 100,
      pointsEarned: o.points_earned,
      items_json: o.items_json,
      created_at: o.created_at,
      paid_at: o.paid_at,
    }))
  });
});

// ============================================================================
// NEWSLETTER ROUTE
// ============================================================================

app.post('/api/newsletter/subscribe', async (c) => {
  try {
    const { email } = await c.req.json();
    
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Ungültige E-Mail-Adresse' }, 400);
    }
    
    // Check if already subscribed
    const existing = await c.env.DB.prepare(
      'SELECT id FROM newsletter_subscribers WHERE email = ?'
    ).bind(email.toLowerCase()).first();
    
    if (existing) {
      return c.json({ message: 'Du bist bereits angemeldet!' });
    }
    
    // Add subscriber
    await c.env.DB.prepare(`
      INSERT INTO newsletter_subscribers (id, email, subscribed_at)
      VALUES (?, ?, datetime('now'))
    `).bind(generateId(), email.toLowerCase()).run();
    
    // If user is logged in, award bonus points
    const session = await getSession(c);
    if (session) {
      await c.env.DB.prepare(
        'UPDATE users SET points_balance = points_balance + ? WHERE id = ?'
      ).bind(POINTS_CONFIG.NEWSLETTER_BONUS, session.userId).run();
      
      await c.env.DB.prepare(`
        INSERT INTO points_transactions (id, user_id, amount, type, source, created_at)
        VALUES (?, ?, ?, 'EARN', 'NEWSLETTER', datetime('now'))
      `).bind(generateId(), session.userId, POINTS_CONFIG.NEWSLETTER_BONUS).run();
      
      return c.json({
        success: true,
        message: `Danke für deine Anmeldung! Du hast ${POINTS_CONFIG.NEWSLETTER_BONUS} Bonuspunkte erhalten.`,
        bonusPoints: POINTS_CONFIG.NEWSLETTER_BONUS
      });
    }
    
    return c.json({
      success: true,
      message: 'Danke für deine Anmeldung zum LUNARA Newsletter!'
    });
    
  } catch (error) {
    console.error('Newsletter error:', error);
    return c.json({ error: 'Anmeldung fehlgeschlagen' }, 500);
  }
});

// ============================================================================
// PROFILE UPDATE ROUTES
// ============================================================================

// Update user profile
app.put('/api/auth/update', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  try {
    const { name } = await c.req.json();
    
    await c.env.DB.prepare(
      'UPDATE users SET name = ? WHERE id = ?'
    ).bind(name || null, session.userId).run();
    
    return c.json({ success: true, message: 'Profil aktualisiert' });
    
  } catch (error) {
    console.error('Profile update error:', error);
    return c.json({ error: 'Aktualisierung fehlgeschlagen' }, 500);
  }
});

// Update profile (PATCH method)
app.patch('/api/auth/profile', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  try {
    const { name } = await c.req.json();
    
    await c.env.DB.prepare(
      'UPDATE users SET name = ? WHERE id = ?'
    ).bind(name || null, session.userId).run();
    
    return c.json({ success: true, message: 'Profil aktualisiert' });
    
  } catch (error) {
    console.error('Profile update error:', error);
    return c.json({ error: 'Aktualisierung fehlgeschlagen' }, 500);
  }
});

// Change password
app.post('/api/auth/change-password', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  try {
    const { currentPassword, newPassword } = await c.req.json();
    
    if (!currentPassword || !newPassword) {
      return c.json({ error: 'Beide Passwörter erforderlich' }, 400);
    }
    
    if (newPassword.length < 8) {
      return c.json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben' }, 400);
    }
    
    // Verify current password
    const user = await c.env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    ).bind(session.userId).first<User>();
    
    if (!user) {
      return c.json({ error: 'Benutzer nicht gefunden' }, 404);
    }
    
    const validPassword = await verifyPassword(currentPassword, user.password_hash);
    if (!validPassword) {
      return c.json({ error: 'Aktuelles Passwort ist falsch' }, 401);
    }
    
    // Update password
    const newPasswordHash = await hashPassword(newPassword);
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?'
    ).bind(newPasswordHash, session.userId).run();
    
    return c.json({ success: true, message: 'Passwort geändert' });
    
  } catch (error) {
    console.error('Password change error:', error);
    return c.json({ error: 'Passwortänderung fehlgeschlagen' }, 500);
  }
});

// Alias for password change
app.post('/api/auth/password', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  try {
    const { currentPassword, newPassword } = await c.req.json();
    
    if (!currentPassword || !newPassword) {
      return c.json({ error: 'Beide Passwörter erforderlich' }, 400);
    }
    
    if (newPassword.length < 8) {
      return c.json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben' }, 400);
    }
    
    const user = await c.env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    ).bind(session.userId).first<User>();
    
    if (!user) {
      return c.json({ error: 'Benutzer nicht gefunden' }, 404);
    }
    
    const validPassword = await verifyPassword(currentPassword, user.password_hash);
    if (!validPassword) {
      return c.json({ error: 'Aktuelles Passwort ist falsch' }, 401);
    }
    
    const newPasswordHash = await hashPassword(newPassword);
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?'
    ).bind(newPasswordHash, session.userId).run();
    
    return c.json({ success: true, message: 'Passwort geändert' });
    
  } catch (error) {
    console.error('Password change error:', error);
    return c.json({ error: 'Passwortänderung fehlgeschlagen' }, 500);
  }
});

// Delete account
app.delete('/api/auth/delete', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'Nicht angemeldet' }, 401);
  }
  
  try {
    // Delete user and related data
    await c.env.DB.prepare('DELETE FROM points_transactions WHERE user_id = ?').bind(session.userId).run();
    await c.env.DB.prepare('DELETE FROM orders WHERE user_id = ?').bind(session.userId).run();
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(session.userId).run();
    
    // Invalidate session
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      await c.env.SESSIONS.delete(token);
    }
    
    return c.json({ success: true, message: 'Konto gelöscht' });
    
  } catch (error) {
    console.error('Delete account error:', error);
    return c.json({ error: 'Löschung fehlgeschlagen' }, 500);
  }
});

// ============================================================================
// CONTACT FORM
// ============================================================================

app.post('/api/contact', async (c) => {
  try {
    const { name, email, subject, order, message } = await c.req.json();
    
    if (!name || !email || !message) {
      return c.json({ error: 'Name, E-Mail und Nachricht erforderlich' }, 400);
    }
    
    // Store contact request in DB
    await c.env.DB.prepare(`
      INSERT INTO contact_requests (id, name, email, subject, order_id, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(generateId(), name, email.toLowerCase(), subject || 'Allgemein', order || null, message).run();
    
    // TODO: Send notification email via Brevo
    
    return c.json({
      success: true,
      message: 'Nachricht gesendet! Wir melden uns bald.'
    });
    
  } catch (error) {
    console.error('Contact form error:', error);
    return c.json({ error: 'Nachricht konnte nicht gesendet werden' }, 500);
  }
});

// ============================================================================
// PRODUCTS ROUTE (serves from static JSON but could be DB-backed)
// ============================================================================

app.get('/api/products', async (c) => {
  // In production, this would come from D1
  // For now, we serve from static file via assets binding
  return c.env.ASSETS.fetch(new Request(`${c.env.SITE_URL}/data/products.json`));
});

// ============================================================================
// STATIC ASSETS FALLBACK
// ============================================================================

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
