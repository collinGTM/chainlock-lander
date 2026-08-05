# chainlock.gg — deploy guide

Everything here runs on Cloudflare's free tier: hosting (Pages), the payment and
access endpoints (Pages Functions), and storage (KV). Namecheap stays your
registrar; Cloudflare takes over DNS and serving. Payments go through Stripe and
the access email goes out through Resend, both also on free tiers to start.

Folder layout — keep it exactly like this:

```
chainlock-lander/
├── README.md          ← this guide (kept OUTSIDE site/ so it never gets
│                        deployed and served publicly)
└── site/              ← everything in here is what gets deployed
    ├── index.html
    ├── success.html            ← Stripe's success_url landing page
    ├── _headers                ← security headers + CSP
    ├── .dev.vars               ← LOCAL secrets, gitignored, never deployed
    └── functions/
        ├── api/
        │   ├── checkout.js         → /api/checkout       (creates the session)
        │   └── stripe-webhook.js   → /api/stripe-webhook (fulfils the sale)
        └── claim/
            ├── index.js            → /claim              (validates the code)
            └── callback.js         → /claim/callback     (grants the role)
```

There is deliberately **no `package.json` and no build step**. Every function
talks to Stripe, Discord and Resend over plain `fetch`, so `wrangler` ships the
files as-is and the deploy command below never changes.

## The money and access flow, end to end

1. Visitor clicks **Get Wolf Den access $25**. The page POSTs `/api/checkout`.
2. `/api/checkout` creates a Stripe Checkout Session and returns its hosted URL.
   The browser navigates there. No card data ever touches chainlock.gg.
3. Stripe takes payment and sends the buyer to `/success`.
4. Stripe calls `/api/stripe-webhook`. That mints a one-time claim code, stores
   it in KV, and emails the buyer a link to `/claim?code=…`.
5. The buyer opens the link, authorises on Discord, and `/claim/callback` puts
   them in the guild with the paid role attached.

Access is granted by the **webhook**, not by the buyer reaching `/success`. A
closed tab or a failed redirect never costs anyone their access.

## 1. Point the domain at Cloudflare

Sign up at dash.cloudflare.com (Free plan), click "Add a domain", and enter
`chainlock.gg`. Cloudflare will show you two nameservers (like
`ada.ns.cloudflare.com` / `rob.ns.cloudflare.com`). In Namecheap: Domain List →
Manage next to chainlock.gg → Nameservers → switch to "Custom DNS" → paste
those two nameservers → save. Propagation usually takes minutes, occasionally
up to 24h; Cloudflare emails you when it's active.

## 2. Deploy the site

Install Node if you don't have it (v18+; `nvm install --lts` is the clean way on
Linux), then:

```
cd site
npx wrangler login
npx wrangler pages deploy . --project-name=chainlock --branch=production --commit-dirty=true
```

Deploy from INSIDE `site/`, and pass `.`, never an absolute path. See CLAUDE.md
for the two ways this silently ships a broken site, both of which have actually
happened.

Then in the Pages project → Custom domains → add `chainlock.gg` and
`www.chainlock.gg`. HTTPS is automatic.

**At this point the site works but cannot take money**: `/api/checkout` answers
503 by design until step 4, and the buy button shows an honest error rather than
doing nothing. That is deliberate, so the site is deployable and testable before
any credential exists.

## 3. Storage (KV)

Dashboard → Workers & Pages → KV → Create namespace → name it
`chainlock-members`. Then in the Pages project → Settings → Bindings → Add →
KV namespace → variable name `MEMBERS` (must be exactly that) → select the
namespace. Redeploy to pick it up.

Keys written:

| Key | Holds |
|---|---|
| `claim:<code>` | the one-time access code, and whether it was used |
| `member:<email>` | per-buyer record, including their Discord user id once claimed |
| `sess:<checkout_session_id>` | maps a Stripe session to its code, so retries reuse it |
| `pi:<payment_intent_id>` | maps a payment back to an email, for refunds |
| `evt:<stripe_event_id>` | idempotency marker so a retried webhook does nothing twice |
| `state:<state>` | short-lived OAuth CSRF token, expires in 10 minutes |

Free-tier KV allows 1,000 writes/day. A sale writes about five keys, so that is
roughly 200 sales a day before you would notice, and if you blow past that it is
a champagne problem.

> **Reading keys back:** `wrangler kv key list --binding=MEMBERS` does **not**
> work in this repo. `--binding` resolves through a `wrangler.toml`, and there
> isn't one by design. Use `--namespace-id=<id>` instead, with the id from the
> KV page in the dashboard.

### The old launch list

`SIGNUPS` (namespace `chainlock-signups`) held the pre-launch email list. That
form and its `/api/subscribe` endpoint were removed when the site switched to
selling access. **The namespace and its data were left untouched**, so the list
is still there for the free-join nurture sequence when that gets built. Export it
with the `--namespace-id` form above.

## 4. Stripe

1. Create the $25 one-time **price** (Products → add a product → one-time).
2. Pages project → Settings → Environment variables:
   - `STRIPE_SECRET_KEY` (Secret)
   - `STRIPE_PRICE_ID` (plain text)
   - `SITE_ORIGIN` = `https://chainlock.gg` (plain text)
3. Developers → Webhooks → add endpoint `https://chainlock.gg/api/stripe-webhook`,
   subscribed to **`checkout.session.completed`** and **`charge.refunded`**.
4. Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` (Secret).

The signing secret is per-endpoint. The one printed by `stripe listen` during
local testing is a different value and will not verify production traffic.

## 5. Discord

Create an app at discord.com/developers, then:

1. **Bot** → add a bot → copy the token into `DISCORD_BOT_TOKEN` (Secret).
2. **OAuth2** → add redirect URI `https://chainlock.gg/claim/callback`. It has to
   match character for character or Discord refuses the handover.
   Copy the client id and secret into `DISCORD_CLIENT_ID` (plain) and
   `DISCORD_CLIENT_SECRET` (Secret).
3. Invite the bot to the server with **both** of these permissions:
   - **Create Instant Invite** — required to add a member to the guild at all.
   - **Manage Roles** — required to attach the paid role while doing it.
   A bot with only Manage Roles fails for anyone not already in the server; a bot
   with only Create Instant Invite adds them with no paid access.
4. Create the paid role and restrict the paid channels to it. Leave the free
   channels open: the site points at them as proof, and the copy promises you can
   read the record before paying.
5. **Drag the bot's own role ABOVE the paid role** in Server Settings → Roles.
   Discord refuses role assignment with a 403 if the bot's highest role sits
   below the role it is trying to grant, no matter which permissions are ticked.
6. Turn on Developer Mode (User Settings → Advanced) to right-click → Copy ID for
   the server and the role, into `DISCORD_GUILD_ID` and `DISCORD_PAID_ROLE_ID`.

## 6. Email (Resend)

Sign up at resend.com and **verify `chainlock.gg` as a sending domain** (it hands
you SPF and DKIM records; DNS is already on Cloudflare so this takes a minute).
Sending to real buyers does not work until the domain is verified.

Then set `RESEND_API_KEY` (Secret) and `MEMBER_FROM_EMAIL` (plain, e.g.
`access@chainlock.gg`). Free tier is 3,000 emails/month and 100/day.

## 7. Full environment variable list

| Var | Type | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | Secret | creates checkout sessions |
| `STRIPE_PRICE_ID` | plain | the $25 one-time price |
| `STRIPE_WEBHOOK_SECRET` | Secret | verifies webhook signatures |
| `RESEND_API_KEY` | Secret | sends the access email |
| `MEMBER_FROM_EMAIL` | plain | the From address |
| `DISCORD_CLIENT_ID` | plain | OAuth app |
| `DISCORD_CLIENT_SECRET` | Secret | OAuth token exchange |
| `DISCORD_BOT_TOKEN` | Secret | adds members, grants roles |
| `DISCORD_GUILD_ID` | plain | the server |
| `DISCORD_PAID_ROLE_ID` | plain | the paid role |
| `SITE_ORIGIN` | plain | `https://chainlock.gg` |

Plus the `MEMBERS` KV binding from step 3.

## 8. Local development

Put the same values in `site/.dev.vars` (gitignored, never deployed), then:

```
cd site
npx wrangler pages dev . --port 8788 --kv MEMBERS
```

For webhooks, `stripe listen --forward-to localhost:8788/api/stripe-webhook`.
Drive a real test-mode purchase with card `4242 4242 4242 4242` rather than
`stripe trigger`, because the synthetic event carries no real
`customer_details.email` and the webhook needs one to send the access link.

## 9. Pre-launch odds and ends

The ticker tape should show a teal "LIVE · 24H" tag once deployed; if it ever
shows "SIM", both price APIs failed and the tape is honestly labeling itself as
simulated. Do not paper over that.

Before the first live sale, make sure the **old Railway webhook endpoint
(`vibrant-legacy`) is disabled** in Stripe. If both it and
`/api/stripe-webhook` are subscribed to `checkout.session.completed`, every
purchase gets handled twice by two different systems.
