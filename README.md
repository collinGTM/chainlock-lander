# chainlock.gg — deploy guide

Everything here runs on Cloudflare's free tier: hosting (Pages), the signup
endpoint (Pages Functions), storage (KV), and bot protection (Turnstile).
Namecheap stays your registrar; Cloudflare takes over DNS and serving.

Folder layout — keep it exactly like this:

```
chainlock/
├── README.md          ← this guide (kept OUTSIDE site/ so it never gets
│                        deployed and served publicly)
└── site/              ← everything in here is what gets deployed
    ├── index.html
    ├── _headers                ← security headers + CSP
    └── functions/
        └── api/
            └── subscribe.js    ← the signup endpoint (becomes /api/subscribe)
```

## 1. Point the domain at Cloudflare

Sign up at dash.cloudflare.com (Free plan), click "Add a domain", and enter
`chainlock.gg`. Cloudflare will show you two nameservers (like
`ada.ns.cloudflare.com` / `rob.ns.cloudflare.com`). In Namecheap: Domain List →
Manage next to chainlock.gg → Nameservers → switch to "Custom DNS" → paste
those two nameservers → save. Propagation usually takes minutes, occasionally
up to 24h; Cloudflare emails you when it's active.

## 2. Deploy the site

Recommended path (handles the `functions/` folder correctly): install Node if
you don't have it (v18+; `nvm install --lts` is the clean way on Linux), then:

```
cd site
npx wrangler login
npx wrangler pages deploy . --project-name=chainlock
```

Deploy from INSIDE `site/` — deploying the parent folder would publish this
README as a page on your site.

Alternative: push this folder to a GitHub repo and use Workers & Pages →
Create → Pages → "Connect to Git" (no build command, output directory `/`).
Every push then auto-deploys. Avoid the dashboard drag-and-drop uploader —
it can skip the `functions/` folder, which would kill the form endpoint.

Then in the Pages project → Custom domains → add `chainlock.gg` and
`www.chainlock.gg`. HTTPS is automatic.

**At this point the form already works**: honeypot + validation are active,
and Turnstile is simply skipped until you do step 4. Submissions succeed but
aren't stored until step 3.

## 3. Store signups (KV)

Dashboard → Workers & Pages → KV → Create namespace → name it
`chainlock-signups`. Then in the Pages project → Settings → Bindings →
Add → KV namespace → variable name `SIGNUPS` (must be exactly that) →
select the namespace. Redeploy (re-run the wrangler command) to pick it up.

Emails are stored as keys (which deduplicates for free) with a small JSON
value: signup timestamp + visitor country. Read them anytime in the dashboard
KV browser, or export with:

```
npx wrangler kv key list --binding=SIGNUPS --remote
```

Free-tier KV allows 1,000 writes/day — that's 1,000 new signups per day
before you'd notice, and if you blow past that it's a champagne problem.

## 4. Turn on bot protection (Turnstile)

Dashboard → Turnstile → Add site → domain `chainlock.gg`, widget mode
"Managed" (it stays invisible for humans). You get two keys:

- **Site key** → open `index.html`, find `TURNSTILE_SITE_KEY = ""` in the
  script, paste it between the quotes.
- **Secret key** → Pages project → Settings → Environment variables → add
  `TURNSTILE_SECRET` (type: Secret) with the value.

Redeploy. The endpoint now rejects any submission without a valid Turnstile
token; the widget only becomes visible to suspicious traffic.

## 5. Pre-launch odds and ends

The Twitter/OG card is text-only — add a 1200×630 `og:image` before posting
the link anywhere, since the image is most of the click. The ticker tape
should show a teal "LIVE · 24H" tag once deployed; if it ever shows "SIM",
both price APIs failed and the tape is honestly labeling itself as simulated.
