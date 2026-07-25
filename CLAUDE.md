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
- **Deploy from inside `site/`**, never the repo root. `wrangler pages
  deploy .` from the root would publish this README as a live page.
- Avoid the Cloudflare dashboard drag-and-drop uploader for deploys; it can
  silently skip `functions/`, which kills the signup endpoint with no error.

## Deploy gotcha: the production branch is `production`, not `master`
The git branch here is `master`, but the Pages project's production branch is
named **`production`**. `wrangler pages deploy` defaults to the current git
branch, so a plain deploy lands as a **Preview** on `master.chainlock.pages.dev`
and **chainlock.gg does not change** — while wrangler still prints
"Deployment complete!" and a working URL. This has silently happened at least
twice (2026-07-24, and a `master` preview 5h earlier the same day).

## Deploy gotcha 2: `functions/` is found relative to CWD, not the path argument
`wrangler pages deploy <dir>` discovers the `functions/` folder relative to the
**current working directory**, not relative to `<dir>`. Deploying with an
absolute path from the repo root therefore ships the site **with no Functions
bundle at all**, silently killing `/api/subscribe`, while still printing
"Deployment complete!". This happened on 2026-07-24 and the signup endpoint was
dead in production until it was caught.

Tell the two apart by the deploy output. A correct deploy prints **both**:
```
✨ Compiled Worker successfully
✨ Uploading Functions bundle
```
If those two lines are missing, the Worker did not ship. Redeploy, don't shrug.

## The only correct deploy command
`cd` into `site/` first and deploy `.` — never an absolute path, never the root:
```
cd ~/chainlock-lander/site
npx wrangler pages deploy . --project-name=chainlock --branch=production --commit-dirty=true
```
Then verify against the live apex, never the success line:
```
curl -s -o /dev/null -w '%{http_code}\n' https://chainlock.gg/api/subscribe   # want 405
curl -s https://chainlock.gg/ | grep -c 'og:image'                            # want 5
npx wrangler pages deployment list --project-name=chainlock                   # Environment column
```

## Stack
Cloudflare Pages (free tier) for hosting + the Pages Functions signup
endpoint. KV (`SIGNUPS` binding — must be that exact variable name) stores
signups: email as key (dedupes for free) + JSON value of timestamp/country.
Turnstile gates the signup endpoint — site key is pasted into `index.html`
(`TURNSTILE_SITE_KEY`), secret key is a Pages env var (`TURNSTILE_SECRET`).
Namecheap is registrar only; Cloudflare owns DNS/serving.

## Live-site tells
The **topbar** (right side) shows a teal "LIVE · 24H" tag once a price API is
working. If it shows "SIM" instead, both price APIs failed and the tape is
honestly labeling itself as simulated — don't treat that as a UI bug to
silently patch over. (The tag used to sit on the ticker tape itself; it moved
to the topbar in the 2026-07-24 redesign, since that's the status line.)

## Colour law — the thing to not get wrong
The page inherits `chainlock-terminal/DESIGN.md` §6 and no longer excepts
itself from it: neutral ramp for all chrome and type; violet/amber/teal for
**build lifecycle stage only** (the board + the fuse); green/red for **price
change only** (the tape). The launch fuse is the one sanctioned gradient
(§6 permits it). Do not add gradients, glows, or coloured shadows back —
that break is what made the old page read as generic. Tokens mirror to
`tokens.css` at the repo root (not served, not linked — CSP `style-src` has
no `'self'`); keep the two in sync or delete the mirror.

## Pre-launch checklist gotcha
No `og:image` is set yet (text-only card) — add a 1200×630 image before the
link goes out anywhere; it's most of what gets clicked in a social preview.
