#!/usr/bin/env bash
#
# Proves setup/push-env.sh actually rejects bad input.
#
# Every case below is a real paste mistake. A validation that cannot reject is
# decoration, so each case asserts BOTH a non-zero exit AND the specific message,
# and the suite starts by proving a clean file passes (otherwise "everything
# fails" would look like a pass).
#
# Runs with --dry-run throughout, so Cloudflare is never contacted.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/setup/push-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAILED=()

# A fully valid file. Every case below is this with exactly one thing broken,
# so a failure can only be caused by the thing under test.
write_valid() {
  cat > "$1" <<'EOF'
STRIPE_SECRET_KEY=sk_test_FAKE_fixture_not_a_key
STRIPE_PRICE_ID=price_1AbCdEfGhIjKlMnOpQrStUvW
STRIPE_WEBHOOK_SECRET=whsec_AbCdEfGhIjKlMnOpQrStUvWxYz
RESEND_API_KEY=re_AbCdEfGh_IjKlMnOpQrStUvWxYz
MEMBER_FROM_EMAIL=Chainlock <access@chainlock.gg>
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=AbCdEfGhIjKlMnOpQrStUvWxYz012345
DISCORD_BOT_TOKEN=MTIzNDU2Nzg5.AbCdEf.GhIjKlMnOpQrStUvWxYz0123456
DISCORD_GUILD_ID=234567890123456789
DISCORD_PAID_ROLE_ID=345678901234567890
SITE_ORIGIN=https://chainlock.gg
EOF
}

# break <name> <sed-expression> <expected-substring>
break_case() {
  local name="$1" sed_expr="$2" expect="$3"
  local f="$TMP/case.vars"
  write_valid "$f"
  sed -i "$sed_expr" "$f"
  local out rc
  out="$(DEV_VARS_FILE="$f" bash "$SCRIPT" --dry-run 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "$expect"; then
    echo "REJECTED (good)  $name"
    PASS=$((PASS + 1))
  else
    echo "ACCEPTED (BAD)   $name  :: exit $rc"
    printf '%s\n' "$out" | sed 's/^/                   /' | head -4
    FAILED+=("$name")
  fi
}

echo "=== the clean file must pass, or nothing below means anything ==="
CLEAN="$TMP/clean.vars"
write_valid "$CLEAN"
out="$(DEV_VARS_FILE="$CLEAN" bash "$SCRIPT" --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Dry run"; then
  echo "ACCEPTED (good)  a fully valid file"
  PASS=$((PASS + 1))
else
  echo "REJECTED (BAD)   a fully valid file  :: exit $rc"
  printf '%s\n' "$out" | sed 's/^/                   /'
  FAILED+=("valid file rejected")
fi

echo
echo "=== each individual paste mistake must be caught ==="
break_case "product id pasted where price id belongs" \
  's|^STRIPE_PRICE_ID=.*|STRIPE_PRICE_ID=prod_AbCdEfGhIjKlMn|' \
  "is a PRODUCT id"

break_case "publishable key pasted as the secret key" \
  's|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=pk_test_51AbCdEfGh|' \
  "PUBLISHABLE key"

break_case "restricted key pasted as the secret key" \
  's|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=rk_test_51AbCdEfGh|' \
  "restricted key"

break_case "signing secret missing its whsec_ prefix" \
  's|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=AbCdEfGhIjKl|' \
  "does not look like a signing secret"

break_case "resend key missing its re_ prefix" \
  's|^RESEND_API_KEY=.*|RESEND_API_KEY=AbCdEfGhIjKl|' \
  "does not look like a Resend key"

break_case "from-address with no @" \
  's|^MEMBER_FROM_EMAIL=.*|MEMBER_FROM_EMAIL=Chainlock|' \
  "no @ in it"

break_case "channel id pasted instead of a server id (too short)" \
  's|^DISCORD_GUILD_ID=.*|DISCORD_GUILD_ID=12345|' \
  "is not a Discord id"

break_case "role id with non-digits in it" \
  's|^DISCORD_PAID_ROLE_ID=.*|DISCORD_PAID_ROLE_ID=345678901234567890x|' \
  "is not a Discord id"

break_case "bot token pasted with the word Bot in front" \
  's|^DISCORD_BOT_TOKEN=.*|DISCORD_BOT_TOKEN=Bot MTIzNDU2.AbCdEf.GhIjKl|' \
  "includes the word 'Bot'"

break_case "site origin with a trailing slash" \
  's|^SITE_ORIGIN=.*|SITE_ORIGIN=https://chainlock.gg/|' \
  "trailing slash"

break_case "site origin left on localhost" \
  's|^SITE_ORIGIN=.*|SITE_ORIGIN=http://127.0.0.1:8788|' \
  "points at localhost"

break_case "site origin with no scheme" \
  's|^SITE_ORIGIN=.*|SITE_ORIGIN=chainlock.gg|' \
  "no scheme"

echo
echo "=== a blank value must be caught, for every variable ==="
for key in STRIPE_SECRET_KEY STRIPE_PRICE_ID STRIPE_WEBHOOK_SECRET RESEND_API_KEY \
           MEMBER_FROM_EMAIL DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET \
           DISCORD_BOT_TOKEN DISCORD_GUILD_ID DISCORD_PAID_ROLE_ID SITE_ORIGIN; do
  break_case "blank $key" "s|^$key=.*|$key=|" "$key is empty"
done

echo
echo "=== a missing file must not be treated as an empty-but-fine one ==="
out="$(DEV_VARS_FILE="$TMP/does-not-exist" bash "$SCRIPT" --dry-run 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "No site/.dev.vars found"; then
  echo "REJECTED (good)  missing .dev.vars"
  PASS=$((PASS + 1))
else
  echo "ACCEPTED (BAD)   missing .dev.vars  :: exit $rc"
  FAILED+=("missing file")
fi

echo
echo "=== values must never be printed ==="
out="$(DEV_VARS_FILE="$CLEAN" bash "$SCRIPT" --dry-run 2>&1)"
LEAKED=()
for secret in sk_test_FAKE_fixture_not_a_key whsec_AbCdEfGhIjKlMnOpQrStUvWxYz \
              re_AbCdEfGh_IjKlMnOpQrStUvWxYz AbCdEfGhIjKlMnOpQrStUvWxYz012345 \
              MTIzNDU2Nzg5.AbCdEf.GhIjKlMnOpQrStUvWxYz0123456; do
  printf '%s' "$out" | grep -qF "$secret" && LEAKED+=("$secret")
done
if [ "${#LEAKED[@]}" -eq 0 ]; then
  echo "CLEAN (good)     no secret value appeared in the output"
  PASS=$((PASS + 1))
else
  echo "LEAKED (BAD)     ${#LEAKED[@]} secret value(s) printed to the terminal"
  FAILED+=("secret leak")
fi

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "$PASS passed, ${#FAILED[@]} FAILED: ${FAILED[*]}"
  exit 1
fi
echo "$PASS passed, 0 failed"
