#!/usr/bin/env bash
#
# Pushes the values from site/.dev.vars into the Cloudflare Pages project, so
# they are typed once rather than re-keyed into eleven dashboard fields.
#
#   ./setup/push-env.sh              push for real
#   ./setup/push-env.sh --dry-run    validate only, contact nothing
#
# Everything goes in as a Pages "secret". Secrets are just encrypted environment
# variables and the Worker reads them identically to plain ones, so there is no
# reason to split them across two mechanisms.
#
# This script prints variable NAMES only. It never echoes a value.

set -uo pipefail

PROJECT="chainlock"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DEV_VARS_FILE exists so the validation logic can be tested against deliberately
# broken fixtures without touching the real file. Normal use ignores it.
ENV_FILE="${DEV_VARS_FILE:-$REPO_ROOT/site/.dev.vars}"
EXAMPLE_FILE="$REPO_ROOT/site/.dev.vars.example"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Every variable the Functions actually read. Keep in step with README section 7.
REQUIRED=(
  STRIPE_SECRET_KEY
  STRIPE_PRICE_ID
  STRIPE_WEBHOOK_SECRET
  RESEND_API_KEY
  MEMBER_FROM_EMAIL
  DISCORD_CLIENT_ID
  DISCORD_CLIENT_SECRET
  DISCORD_BOT_TOKEN
  DISCORD_GUILD_ID
  DISCORD_PAID_ROLE_ID
  SITE_ORIGIN
)

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

if [ ! -f "$ENV_FILE" ]; then
  red "No site/.dev.vars found."
  echo
  echo "Start from the template, which says where every value comes from:"
  echo "    cp site/.dev.vars.example site/.dev.vars"
  echo
  echo "Then fill it in following SETUP.md, and re-run this."
  [ -f "$EXAMPLE_FILE" ] || red "(site/.dev.vars.example is missing too, which is a repo problem)"
  exit 1
fi

# ---- parse ----------------------------------------------------------------
# Deliberately NOT `source`d: .dev.vars is a data file, and sourcing it would
# execute whatever happens to be in it.
declare -A VALS
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  key="${key//[[:space:]]/}"
  # Trim surrounding whitespace and one layer of matching quotes from the value.
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  case "$val" in
    \"*\") val="${val%\"}"; val="${val#\"}" ;;
    \'*\') val="${val%\'}"; val="${val#\'}" ;;
  esac
  [ -n "$key" ] && VALS["$key"]="$val"
done < "$ENV_FILE"

# ---- validate -------------------------------------------------------------
PROBLEMS=0
problem() { red "  ✗ $1"; echo "      $2"; PROBLEMS=$((PROBLEMS + 1)); }
warn()    { ylw "  ! $1"; echo "      $2"; }

bold "Checking site/.dev.vars"
echo

for key in "${REQUIRED[@]}"; do
  if [ -z "${VALS[$key]:-}" ]; then
    problem "$key is empty" "See SETUP.md for where this value comes from."
  fi
done

v() { printf '%s' "${VALS[$1]:-}"; }

# Paste mistakes that otherwise surface much later as a silent failure.
if [ -n "$(v STRIPE_SECRET_KEY)" ]; then
  case "$(v STRIPE_SECRET_KEY)" in
    sk_test_*|sk_live_*) ;;
    rk_*) problem "STRIPE_SECRET_KEY is a restricted key" "Use the standard secret key from Developers → API keys." ;;
    pk_*) problem "STRIPE_SECRET_KEY is a PUBLISHABLE key" "You want the Secret key, not the Publishable one." ;;
    *)    problem "STRIPE_SECRET_KEY does not look like a Stripe secret key" "Expected it to start sk_test_ or sk_live_." ;;
  esac
fi

if [ -n "$(v STRIPE_PRICE_ID)" ]; then
  case "$(v STRIPE_PRICE_ID)" in
    price_*) ;;
    prod_*)  problem "STRIPE_PRICE_ID is a PRODUCT id, not a price id" "Open the product and copy the API ID from the Pricing section. It starts price_." ;;
    *)       problem "STRIPE_PRICE_ID does not look like a price id" "Expected it to start price_." ;;
  esac
fi

if [ -n "$(v STRIPE_WEBHOOK_SECRET)" ]; then
  case "$(v STRIPE_WEBHOOK_SECRET)" in
    whsec_*) ;;
    *)       problem "STRIPE_WEBHOOK_SECRET does not look like a signing secret" "Expected it to start whsec_. It is on the endpoint's own page, under Signing secret." ;;
  esac
fi

if [ -n "$(v RESEND_API_KEY)" ]; then
  case "$(v RESEND_API_KEY)" in
    re_*) ;;
    *)    problem "RESEND_API_KEY does not look like a Resend key" "Expected it to start re_." ;;
  esac
fi

if [ -n "$(v MEMBER_FROM_EMAIL)" ]; then
  case "$(v MEMBER_FROM_EMAIL)" in
    *@*) ;;
    *)   problem "MEMBER_FROM_EMAIL has no @ in it" "Use access@chainlock.gg or \"Chainlock <access@chainlock.gg>\"." ;;
  esac
fi

# Discord ids are snowflakes: 17 to 20 digits, nothing else.
for key in DISCORD_CLIENT_ID DISCORD_GUILD_ID DISCORD_PAID_ROLE_ID; do
  val="$(v "$key")"
  [ -z "$val" ] && continue
  if ! [[ "$val" =~ ^[0-9]{17,20}$ ]]; then
    problem "$key is not a Discord id" "Expected 17 to 20 digits. Turn on Developer Mode and use right-click → Copy ID."
  fi
done

if [ -n "$(v DISCORD_BOT_TOKEN)" ]; then
  case "$(v DISCORD_BOT_TOKEN)" in
    "Bot "*) problem "DISCORD_BOT_TOKEN includes the word 'Bot'" "Paste the token only. The code adds the 'Bot ' prefix itself, and having it twice fails auth." ;;
  esac
  # A bot token is three dot-separated segments. A client secret is one blob,
  # and pasting that here is an easy mix-up on the same page.
  if [[ "$(v DISCORD_BOT_TOKEN)" != *.*.* ]]; then
    warn "DISCORD_BOT_TOKEN does not look like a bot token" "Bot tokens have two dots in them. Check you did not paste the Client Secret."
  fi
fi

if [ -n "$(v SITE_ORIGIN)" ]; then
  case "$(v SITE_ORIGIN)" in
    */)      problem "SITE_ORIGIN has a trailing slash" "Drop it. It would produce URLs like https://chainlock.gg//success." ;;
  esac
  case "$(v SITE_ORIGIN)" in
    http://*|https://*) ;;
    *) problem "SITE_ORIGIN has no scheme" "Use https://chainlock.gg" ;;
  esac
  case "$(v SITE_ORIGIN)" in
    *localhost*|*127.0.0.1*)
      problem "SITE_ORIGIN points at localhost" "That is the local-testing value. Production needs https://chainlock.gg, or Stripe and Discord will send buyers to your laptop." ;;
  esac
fi

# Mode coherence. Not fatal, but pushing a test key to production is worth
# stopping to think about.
case "$(v STRIPE_SECRET_KEY)" in
  sk_test_*) warn "Stripe is in TEST mode" "Correct for the first run. Nothing real can be charged. Swap to sk_live_ and re-run this when you go live (SETUP.md, Going live)." ;;
  sk_live_*) warn "Stripe is in LIVE mode" "Real cards will be charged. Make sure vibrant-legacy is disabled first, or every purchase gets handled twice." ;;
esac

echo
if [ "$PROBLEMS" -gt 0 ]; then
  red "$PROBLEMS problem(s) found. Nothing was pushed."
  exit 1
fi
grn "All $((${#REQUIRED[@]})) values present and well-formed."
echo

# ---- push -----------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  bold "Dry run, so nothing was sent. Would push to Pages project '$PROJECT':"
  for key in "${REQUIRED[@]}"; do echo "    $key"; done
  exit 0
fi

if ! command -v npx >/dev/null 2>&1; then
  red "npx not found. Install Node 18+ (nvm install --lts)."
  exit 1
fi

bold "Pushing to Pages project '$PROJECT'"
echo "(if this asks you to log in, run: npx wrangler login)"
echo

FAILED=()
for key in "${REQUIRED[@]}"; do
  printf '  %-24s ' "$key"
  if printf '%s' "${VALS[$key]}" | npx wrangler pages secret put "$key" --project-name="$PROJECT" >/dev/null 2>&1; then
    grn "ok"
  else
    red "FAILED"
    FAILED+=("$key")
  fi
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  red "${#FAILED[@]} variable(s) failed to push: ${FAILED[*]}"
  echo "Re-run after checking you are logged in: npx wrangler login"
  exit 1
fi

grn "All values pushed."
echo
bold "Two things this script cannot do for you:"
cat <<'EOF'

  1. The KV binding. Pages bindings have no CLI equivalent.
     Dashboard → Workers & Pages → chainlock → Settings → Bindings →
     Add → KV namespace → variable name MEMBERS → chainlock-members

  2. A redeploy, so the new values take effect:

       cd site
       npx wrangler pages deploy . --project-name=chainlock --branch=production --commit-dirty=true

     Confirm the output has BOTH "Compiled Worker successfully" and
     "Uploading Functions bundle". If either is missing, the Worker did not
     ship and every endpoint is dead while the site still looks fine.

Then check the whole thing end to end:

       node tests/preflight.mjs
EOF
