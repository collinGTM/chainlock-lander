# Setup: turning on paid Wolf Den access

Everything in the codebase is built and tested. This page is only the browser
work, which is the part no script can do for you.

Work top to bottom. As you go, paste each value into `site/.dev.vars` (copy it
from `site/.dev.vars.example` first). At the end, one command pushes the lot to
Cloudflare.

**Two steps have no error message when you get them wrong**, and the first sign
of trouble is a customer who paid and got nothing. They are step 5 (bot
permissions) and **step 7 (role order)**. Everything else fails loudly.

---

## Discord

### 1. Create the app
discord.com/developers/applications → **New Application**. Name it whatever you
like; buyers see this name on the authorise screen, so "Wolf Den" reads better
than "chainlock-bot".

### 2. Bot token
**Bot** tab → **Reset Token** → copy.
→ `DISCORD_BOT_TOKEN`

Shown once. Paste the token only, without the word `Bot` in front of it.

### 3. OAuth credentials
**OAuth2** tab → copy **Client ID**, then **Reset Secret** and copy that.
→ `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`

### 4. Redirect URI
Still on **OAuth2** → **Redirects** → **Add Redirect**:

```
https://chainlock.gg/claim/callback
```

Exactly that. No trailing slash, no `www`. Discord compares it character for
character and refuses the handover on any difference.

### 5. Invite the bot (silent failure #1)
Open this URL, substituting your client id:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268435457
```

`268435457` is **Create Instant Invite** (1) plus **Manage Roles** (268435456).

Both are needed and they fail differently, which is what makes this confusing:

| What you gave it | What breaks |
|---|---|
| Manage Roles only | Anyone **not already in the server** cannot be added at all |
| Create Instant Invite only | They get added with **no paid access** |

If you would rather tick boxes than trust a number, the same thing lives at
**OAuth2 → URL Generator**: scope `bot`, then those two permissions.

### 6. Create the paid role
Server Settings → **Roles** → **Create Role**. Name it whatever the paid tier
is called.

Then restrict your paid channels to it. **Leave the free channels open.** The
site promises people can read the record before paying, and the whole funnel is
join-free-then-upgrade.

### 7. Put the bot's role above it (silent failure #2)
In Server Settings → **Roles**, **drag the bot's own role ABOVE the paid role**.

This is the one that will get you. Discord refuses to assign any role that sits
higher than the bot's own highest role, and it returns a bare 403 with every
permission checkbox correctly ticked and nothing in the UI looking wrong.

```
Roles (top = most senior)
  ├── Admin
  ├── Wolf Den            ← the BOT's role, must be above
  ├── Paid Access         ← the role it hands out
  └── @everyone
```

### 8. Copy the ids
User Settings → **Advanced** → turn on **Developer Mode**.

- Right-click the **server icon** → Copy Server ID → `DISCORD_GUILD_ID`
- Server Settings → Roles → right-click the **paid role** → Copy Role ID →
  `DISCORD_PAID_ROLE_ID`

Right-clicking a *channel* also gives you a long number that looks identical.
That is a channel id and it will fail confusingly. Make sure you clicked the
server icon.

---

## Stripe

Do all of this in **test mode** first. The toggle is top-right.

### 9. The price
**Products** → **Add product**. One-time payment, **$25.00 USD**.

Then open the product and copy the **price** API id from the Pricing section.
It starts `price_`. The `prod_` one is the product and is the wrong value.
→ `STRIPE_PRICE_ID`

### 10. The secret key
**Developers** → **API keys** → Secret key → Reveal. Starts `sk_test_`.
→ `STRIPE_SECRET_KEY`

### 11. The webhook endpoint
**Developers** → **Webhooks** → **Add endpoint**.

- URL: `https://chainlock.gg/api/stripe-webhook`
- Events: **`checkout.session.completed`** and **`charge.refunded`**

`charge.refunded` is not optional. Without it, someone can buy access, claim
their role, refund the payment, and keep the role forever.

### 12. The signing secret
Click into the endpoint you just made → **Signing secret** → Reveal. Starts
`whsec_`.
→ `STRIPE_WEBHOOK_SECRET`

This is specific to this endpoint. The secret `stripe listen` prints during
local testing is a different value and will not verify production traffic.

### 13. Leave the old endpoint alone, for now
`vibrant-legacy` (the Railway bot) stays enabled until the new path is proven.
It gets switched off at cutover, at the bottom of this page.

---

## Resend

### 14. Verify the domain
resend.com → **Domains** → **Add Domain** → `chainlock.gg`. It gives you SPF and
DKIM records; DNS is already on Cloudflare so this takes a minute.

**Wait for the status to read "Verified".** Added-but-unverified looks fine on
the screen and then silently fails to deliver to real buyers.

### 15. API key and sender
**API Keys** → Create. Starts `re_`.
→ `RESEND_API_KEY`

Set `MEMBER_FROM_EMAIL` to an address on that verified domain, e.g.
`Chainlock <access@chainlock.gg>`.

---

## Cloudflare

### 16. The KV namespace
Workers & Pages → **KV** → **Create namespace** → name it `chainlock-members`.

### 17. Bind it
Pages project `chainlock` → **Settings** → **Bindings** → Add → KV namespace.

Variable name must be exactly **`MEMBERS`**.

This is the one dashboard step that has no CLI equivalent, which is why it is
not in the push script.

### 18. Push the environment variables

```
./setup/push-env.sh
```

That reads your filled-in `site/.dev.vars` and pushes all eleven values to the
Pages project, so you do not have to retype them into dashboard fields. It
refuses to run on blanks and catches the common paste mistakes first. It prints
variable names only, never values.

### 19. Redeploy so the bindings take effect

```
cd ~/chainlock-lander/site
npx wrangler pages deploy . --project-name=chainlock --branch=production --commit-dirty=true
```

Check the output contains **both** of these lines:

```
✨ Compiled Worker successfully
✨ Uploading Functions bundle
```

If either is missing the Worker did not ship, and the site will look fine while
every endpoint is dead. See CLAUDE.md; this has happened twice.

---

## Check it worked

```
node tests/preflight.mjs
```

That verifies the bot token, that the bot is in your server, that the paid role
exists, **that the role order is right**, that both permission bits are present,
that the price really is $25 one-time, that the endpoint is subscribed to both
events, that your Stripe key mode matches the endpoint, that the Resend domain
is verified rather than merely added, and that the deployed `/api/checkout`
returns a real Stripe URL instead of its unconfigured 503.

Fix whatever it names, then do a real test purchase:

1. Buy from the deployed site with card `4242 4242 4242 4242`, any future expiry,
   any CVC.
2. Confirm the email arrives.
3. **Click the claim link from a Discord account that is already in the server.**
   That is what real buyers will be, and it exercises a different Discord code
   path than a fresh account does. Testing only with a brand new account leaves
   the common case unproven.
4. Confirm the paid role actually appears on that account.
5. Refund the payment in Stripe and confirm the paid role disappears while free
   access survives.

---

## Going live

Once the test-mode run above passes:

1. Swap `STRIPE_SECRET_KEY` to the live key (`sk_live_`) and re-run
   `./setup/push-env.sh`.
2. Add the webhook endpoint again in **live mode** and push its new signing
   secret. Live and test endpoints have separate signing secrets.
3. **Disable `vibrant-legacy`** in Stripe, after giving its author a heads up.
   Do this *before* the first real sale. If both endpoints are subscribed to
   `checkout.session.completed`, every purchase gets handled twice by two
   different systems.
4. Make one real $25 purchase yourself and refund it. Test mode exercises
   neither the production keys nor the production signing secret, so this is the
   only thing that actually proves them.
