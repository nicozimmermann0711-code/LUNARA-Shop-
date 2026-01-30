# 🌙 LUNARA – Premium Lingerie E-Commerce

> **Deploy-Ready** Cloudflare Workers + D1 + KV + Stripe Integration

Eine vollständige E-Commerce-Plattform für Dessous mit mystischem Dark Theme, LUNARA Points Loyalty-System und Stripe Checkout.

---

## 🚀 Quick Deploy (5 Minuten)

### Voraussetzungen
- [Node.js](https://nodejs.org/) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- [Stripe Account](https://dashboard.stripe.com/register)

### 1. Dependencies installieren
```bash
npm install
```

### 2. D1 Datenbank erstellen
```bash
# Datenbank erstellen
npm run db:create
# Ausgabe: Created database 'lunara-db' with ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Die ID in wrangler.jsonc eintragen:
# "database_id": "DEINE_DATABASE_ID"
```

### 3. KV Namespace erstellen
```bash
npm run kv:create
# Ausgabe: Created namespace 'SESSIONS' with ID: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Die ID in wrangler.jsonc eintragen:
# "id": "DEINE_KV_NAMESPACE_ID"
```

### 4. Secrets konfigurieren
```bash
# Stripe Secret Key (aus https://dashboard.stripe.com/apikeys)
wrangler secret put STRIPE_SECRET_KEY
# Eingabe: sk_live_xxxxx (oder sk_test_xxxxx für Tests)

# Stripe Webhook Secret (wird nach Webhook-Erstellung angezeigt)
wrangler secret put STRIPE_WEBHOOK_SECRET
# Eingabe: whsec_xxxxx

# JWT Secret (beliebiger langer String)
wrangler secret put JWT_SECRET
# Eingabe: dein-super-geheimes-jwt-secret-mindestens-32-zeichen
```

### 5. Datenbank-Schema initialisieren
```bash
npm run db:init
```

### 6. Deploy! 🚀
```bash
npm run deploy
```

---

## 🔧 Stripe Webhook einrichten

1. Gehe zu [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Klicke "Add endpoint"
3. URL: `https://deine-worker-url.workers.dev/api/webhooks/stripe`
4. Events auswählen:
   - `checkout.session.completed`
5. Webhook Secret kopieren und als `STRIPE_WEBHOOK_SECRET` speichern

---

## 📁 Projektstruktur

```
lunara-final/
├── src/
│   └── index.ts          # Backend API (Hono + Stripe + D1)
├── public/
│   ├── css/styles.css    # Design System (867 Zeilen)
│   ├── js/app.js         # Frontend Logic
│   ├── data/products.json
│   ├── assets/img/       # Favicons, Bilder
│   ├── index.html        # Homepage mit Intro-Animation
│   ├── shop.html         # Produktliste + Filter
│   ├── checkout.html     # Stripe Checkout + Points
│   ├── account.html      # Konto, Punkte, Bestellungen
│   ├── checkout-success.html
│   ├── impressum.html
│   ├── datenschutz.html
│   ├── agb.html
│   ├── widerruf.html
│   ├── delivery.html
│   └── kontakt.html
├── schema.sql            # D1 Datenbankschema
├── wrangler.jsonc        # Cloudflare Config
├── package.json
└── tsconfig.json
```

---

## 🌟 Features

### Frontend
- ✅ **Mystisches Dark Theme** – Rose-Gold Akzente, Glassmorphism
- ✅ **Intro Animation** – Cinematic Moonrise-Effekt
- ✅ **Responsive Design** – Mobile-first, alle Breakpoints
- ✅ **Cart Drawer** – Slide-in Warenkorb
- ✅ **Quick View** – Produktvorschau im Modal
- ✅ **Safe Exit** – ESC oder 🔒 Button versteckt Seite
- ✅ **Reveal Animations** – Scroll-triggered, respektiert `prefers-reduced-motion`

### Backend
- ✅ **Hono Router** – Schnell, typsicher, Middleware-Support
- ✅ **D1 Database** – SQLite am Edge
- ✅ **KV Sessions** – Skalierbare Session-Verwaltung
- ✅ **Stripe Checkout** – Hosted Payment Page
- ✅ **Webhook Handler** – Automatische Bestellverarbeitung

### LUNARA Points System
- ✅ **1 Punkt pro 1€** Einkauf
- ✅ **50 Willkommenspunkte** bei Registrierung
- ✅ **25 Punkte** für Newsletter-Anmeldung
- ✅ **3 Tier-Stufen**: MOON → ECLIPSE → NOVA
- ✅ **Bonus-Multiplikatoren**: 1.0x / 1.1x / 1.25x
- ✅ **Einlösung**: 20 Punkte = 1€ (max 20% vom Warenkorb)

---

## 🔌 API Endpoints

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| POST | `/api/auth/register` | Registrierung (+50 Punkte) |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Aktueller User |
| GET | `/api/points` | Punktestand & Tier |
| GET | `/api/points/history` | Transaktionsverlauf |
| POST | `/api/checkout/create-session` | Stripe Session erstellen |
| POST | `/api/webhooks/stripe` | Stripe Webhook |
| GET | `/api/orders` | Bestellhistorie |
| GET | `/api/orders/:id` | Bestelldetails |
| POST | `/api/newsletter/subscribe` | Newsletter (+25 Punkte) |
| GET | `/api/products` | Produktliste |

---

## 🧪 Lokale Entwicklung

```bash
# Lokale Datenbank initialisieren
npm run db:init:local

# Dev Server starten
npm run dev
# → http://localhost:8787
```

### Test-Daten für Stripe
| Karte | Nummer | CVC | Datum |
|-------|--------|-----|-------|
| Erfolg | 4242 4242 4242 4242 | 123 | Zukunft |
| Ablehnung | 4000 0000 0000 0002 | 123 | Zukunft |

---

## 🎨 Design Tokens

```css
/* Farben */
--color-bg: #050508;
--color-surface: #0a0a0f;
--color-accent: #d4a574;      /* Rose-Gold */
--color-accent-light: #e8c9a8;
--color-text: #f5f0eb;

/* Fonts */
--font-display: 'Cinzel', serif;
--font-body: 'Montserrat', sans-serif;
```

---

## 📦 Deployment Checklist

- [ ] `wrangler.jsonc` → Database ID eingetragen
- [ ] `wrangler.jsonc` → KV Namespace ID eingetragen
- [ ] `wrangler.jsonc` → `SITE_URL` angepasst
- [ ] Secrets gesetzt: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET`
- [ ] Datenbank initialisiert: `npm run db:init`
- [ ] Stripe Webhook eingerichtet
- [ ] `checkout.html` → Stripe Public Key ersetzt (Zeile mit `pk_test_`)
- [ ] Produktbilder in `/public/assets/img/` hochgeladen
- [ ] Custom Domain in Cloudflare Dashboard konfiguriert

---

## 🔐 Sicherheit

- ✅ Passwörter mit SHA-256 gehasht
- ✅ Sessions in KV mit TTL
- ✅ CORS konfiguriert
- ✅ Stripe Webhook-Signatur verifiziert
- ✅ SQL Injection Prevention (Prepared Statements)
- ✅ XSS Prevention (keine innerHTML mit User-Input)

---

## 📄 Lizenz

Proprietär – Alle Rechte vorbehalten.

---

**Made with 🌙 by LUNARA**
