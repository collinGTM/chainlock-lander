# CLAUDE.md — chainlock-lander

Landing page for **chainlock.gg**. Unrelated codebase to `chainlock-terminal`
(the actual trading product) — don't cross-reference or share code between
them just because the names are similar.

## Read first
`README.md` is the deploy guide and is authoritative for anything
infra/deploy-related below. This file only exists to flag the things an
agent is likely to get wrong.

## Repo shape — this is the part that bites
```
chainlock-lander/
├── README.md   ← deploy guide; stays OUTSIDE site/ so it's never served
└── site/       ← everything here is what actually deploys
    ├── index.html
    ├── _headers            ← security headers + CSP
    └── functions/api/subscribe.js   ← signup endpoint → /api/subscribe
```
- **Deploy from inside `site/`**, never the repo root — `wrangler pages
  deploy .` from the root would publish this README as a live page.
- Avoid the Cloudflare dashboard drag-and-drop uploader for deploys; it can
  silently skip `functions/`, which kills the signup endpoint with no error.

## Stack
Cloudflare Pages (free tier) for hosting + the Pages Functions signup
endpoint. KV (`SIGNUPS` binding — must be that exact variable name) stores
signups: email as key (dedupes for free) + JSON value of timestamp/country.
Turnstile gates the signup endpoint — site key is pasted into `index.html`
(`TURNSTILE_SITE_KEY`), secret key is a Pages env var (`TURNSTILE_SECRET`).
Namecheap is registrar only; Cloudflare owns DNS/serving.

## Live-site tells
The ticker tape shows a teal "LIVE · 24H" tag once both price APIs are
working. If it shows "SIM" instead, both price APIs failed and it's
honestly labeling itself as simulated — don't treat that as a UI bug to
silently patch over.

## Pre-launch checklist gotcha
No `og:image` is set yet (text-only card) — add a 1200×630 image before the
link goes out anywhere; it's most of what gets clicked in a social preview.
