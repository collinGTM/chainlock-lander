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
    ├── success.html        ← Stripe success_url
    ├── _headers            ← security headers + CSP
    ├── .dev.vars           ← LOCAL secrets, gitignored, never deployed
    └── functions/
        ├── api/checkout.js        → /api/checkout
        ├── api/stripe-webhook.js  → /api/stripe-webhook
        ├── claim/index.js         → /claim
        └── claim/callback.js      → /claim/callback
```
- **Deploy from inside `site/`**, never the repo root. `wrangler pages
  deploy .` from the root would publish this README as a live page.
- Avoid the Cloudflare dashboard drag-and-drop uploader for deploys; it can
  silently skip `functions/`, which kills every endpoint with no error.

## No build step, and keep it that way
There is no `package.json`, no bundler, no npm dependency anywhere. Every
function talks to Stripe/Discord/Resend over raw `fetch` and uses WebCrypto for
signature work. Each function file is **self-contained**, including small
duplicated `json()` / `page()` helpers, rather than importing a shared module.
That is deliberate: it keeps the Functions bundle a flat set of leaves and keeps
the deploy command byte-for-byte identical, which is the thing that has broken
twice below. **Do not add a dependency to "clean this up".**

## `/api/subscribe` is gone. Don't bring it back.
The launch-list email form, its Turnstile gate, and `functions/api/subscribe.js`
were removed when the site switched to selling access. The `SIGNUPS` KV
namespace was deliberately **left intact** with its data, for the free-join
nurture sequence when that gets built.

Note that unknown paths do **not** 404 here: Pages has no `404.html`, so it
serves `index.html` with a 200 for anything unmatched. `GET /api/subscribe`
therefore looks alive. The real tell that it is gone is that a **POST** returns
405 from the static handler instead of the endpoint's old `{"ok":true}` JSON.

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
Cloudflare Pages (free tier) for hosting plus the Pages Functions that take
payment and grant access. KV (`MEMBERS` binding, must be that exact variable
name) stores claim codes, member records and webhook idempotency markers; see
README.md for the key layout. Stripe Checkout takes the $25 one-time payment,
Resend sends the access email, and a Discord bot puts the buyer in the guild
with the paid role. Namecheap is registrar only; Cloudflare owns DNS/serving.

Every function **degrades honestly when unconfigured** rather than throwing:
`/api/checkout` answers 503 without `STRIPE_SECRET_KEY` and the buy button shows
a real message. Keep that property when editing, it is what lets the site be
deployed and browser-tested before credentials exist.

## Discord: the three things that silently grant nothing

1. **`PUT /guilds/{guild}/members/{user}` returns 204 when the user is already
   in the server, and silently IGNORES the `roles` in the request body.** It
   only returns 201 and applies roles for someone genuinely new. The funnel is
   explicitly join-free-then-upgrade, so **204 is the common case**, and the
   follow-up `PUT /members/{user}/roles/{role}` in `claim/callback.js` is what
   makes the majority of purchases work. Test with an account that is *already*
   in the guild; testing only with a fresh account exercises the 201 path and
   proves nothing about real buyers.
2. **The bot needs BOTH `CREATE_INSTANT_INVITE` and `MANAGE_ROLES`.** The first
   is required to add a member at all, the second to attach the role. Only one
   ticked fails in a way that looks like the other thing working.
3. **The bot's own role must sit ABOVE the paid role** in Server Settings →
   Roles, or role assignment 403s regardless of permissions. This is invisible
   from the API side and reads as a mysterious permissions bug.

## Stripe webhook notes
Read the body with `await request.text()` **before** parsing anything: the
signature covers the raw bytes, and parsing first destroys the ability to
verify. Verification uses `crypto.subtle.verify`, which is constant-time by
construction, rather than a hand-rolled hex comparison.

Access is granted by the **webhook**, never by the buyer reaching `/success`, so
a closed tab cannot cost someone their access. Claim codes are keyed to the
checkout session (`sess:<id>`), so a Stripe retry re-sends the same link instead
of minting a second one.

The signing secret is per-endpoint. The value `stripe listen` prints locally is a
different secret and will not verify production traffic.

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
