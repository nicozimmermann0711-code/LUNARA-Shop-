# LUNARA Deployment Checklist

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Login to Cloudflare
wrangler login

# 3. Create D1 database
wrangler d1 create lunara-db
# → Copy database_id to wrangler.jsonc

# 4. Create KV namespace
wrangler kv:namespace create SESSIONS
# → Copy id to wrangler.jsonc

# 5. Run database migrations
wrangler d1 execute lunara-db --file=./schema.sql

# 6. Set secrets
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put JWT_SECRET

# 7. Deploy
wrangler deploy
```

## Post-Deployment

1. **Configure Stripe Webhook**
   - Stripe Dashboard → Webhooks → Add endpoint
   - URL: `https://your-domain.com/api/webhooks/stripe`
   - Events: `checkout.session.completed`

2. **Update checkout.html**
   - Replace `pk_test_...` with your Stripe public key

3. **Custom Domain** (Optional)
   - Cloudflare Dashboard → Workers → Custom Domains
   - Add your domain (e.g., lunara.de)

## Test Checklist

- [ ] Homepage loads with intro animation
- [ ] Products display in shop
- [ ] Add to cart works
- [ ] User registration (+50 points)
- [ ] User login
- [ ] Checkout redirects to Stripe
- [ ] Stripe webhook updates order
- [ ] Points earned after purchase
- [ ] Account page shows orders & points
- [ ] Safe exit button works (ESC key)
- [ ] Newsletter subscription (+25 points)
- [ ] Contact form submits
- [ ] Legal pages accessible

## Files to Customize

- `public/impressum.html` - Company details
- `public/datenschutz.html` - Privacy policy
- `public/agb.html` - Terms & conditions
- `public/kontakt.html` - Contact info
- `public/data/products.json` - Product catalog
- `public/assets/img/` - Product images (replace placeholders)

## Secrets Reference

| Secret | Description |
|--------|-------------|
| `STRIPE_SECRET_KEY` | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `JWT_SECRET` | Random 32+ char string |
| `BREVO_API_KEY` | (Optional) For emails |

---

Support: kontakt@lunara.de
