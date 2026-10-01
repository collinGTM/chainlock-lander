#!/bin/bash
# The only deploy path (2026-10-01). `wrangler pages deploy` uploads EVERY
# file in the directory it is given, dotfiles included, and .gitignore means
# nothing to it. On 2026-10-01 that put site/.dev.vars (Stripe and Discord
# secrets) live at https://chainlock.gg/.dev.vars until it was caught by a
# probe. So: secrets live at the repo root (../.dev.vars, read by
# `wrangler pages dev . --env-file ../.dev.vars`), this script refuses to
# deploy while any unexpected dotfile sits in site/, deploys from inside
# site/ as CLAUDE.md requires, and then probes the live origin for the
# paths a leak would use, comparing content type (this host answers 200
# with index.html for unknown paths, so a status code proves nothing).
set -u
cd "$(dirname "$0")/../site" || exit 1
ALLOWED_DOTFILES='.dev.vars.example'
bad=$(find . -maxdepth 2 -name '.*' -type f ! -name "$ALLOWED_DOTFILES" ! -path './.wrangler/*' | sed 's#^\./##')
if [ -n "$bad" ]; then
  echo "REFUSING TO DEPLOY: these dotfiles would be published from site/:"; echo "$bad" | sed 's/^/  /'
  echo "Move secrets to the repo root (../.dev.vars) and re-run."; exit 2
fi
if [ -d .wrangler ]; then echo "note: site/.wrangler exists (local dev state); wrangler skips it"; fi
echo "deploying site/ to project chainlock, branch production"
npx wrangler pages deploy . --project-name=chainlock --branch=production --commit-dirty=true | tee /tmp/chainlock-deploy.log
grep -q 'Compiled Worker successfully' /tmp/chainlock-deploy.log && grep -q 'Uploading Functions bundle' /tmp/chainlock-deploy.log \
  || { echo "FUNCTIONS BUNDLE DID NOT SHIP (see CLAUDE.md deploy gotcha 2). Redeploy."; exit 3; }
sleep 5
echo "live probes (text/html here means the index fallback, i.e. nothing at that path):"
for p in /.dev.vars /.env /.env.local /.dev.vars.local /.git/HEAD; do
  ct=$(curl -s -o /dev/null -D - --max-time 20 "https://chainlock.gg$p" | grep -i '^content-type' | tr -d '\r' | cut -d' ' -f2)
  printf '  %-18s %s\n' "$p" "${ct:-no answer}"
  case "$ct" in text/html*|"") ;; *) echo "  ALARM: $p is being served as $ct. Delete this deployment, purge the URL, rotate what it holds."; exit 4;; esac
done
echo "og:image tags: $(curl -s --max-time 20 https://chainlock.gg/ | grep -c 'og:image') (want 5)"
echo "done. Environment column check: npx wrangler pages deployment list --project-name=chainlock"
