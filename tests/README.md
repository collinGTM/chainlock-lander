# tests

Guards on the money path. Kept **outside `site/`** so they never deploy, same
reason the top-level README lives out here.

No dependencies and no test runner. Plain `node` against the built-in
`node:sqlite`/WebCrypto, and each test loads the **real** function source from
`site/functions/...` as a data-URL import, so there is no copy that can drift out
of step with what actually ships.

```
node tests/claim.test.mjs          # 28 checks: the Discord OAuth claim flow
node tests/webhook.test.mjs        # 47 checks: signatures, fulfilment, refunds
node tests/prove-red.mjs           #  4 mutations: proves the claim guards can fail
node tests/webhook-prove-red.mjs   #  6 mutations: proves the webhook guards can fail

bash tests/push-env.test.sh        # 26 checks: setup/push-env.sh rejects bad input
node tests/preflight.test.mjs      # 28 checks: preflight reports red when setup is wrong
```

Separately, and not a test, `node tests/preflight.mjs` checks the **live**
configuration (Discord, Stripe, Resend, and the deployed site) using the
credentials in `site/.dev.vars`. Run it after following SETUP.md, before taking
any real money.

## Why the two `prove-red` files exist

A test that cannot fail proves nothing. Those two scripts reintroduce a specific
real defect into the source **in memory** (the repo file is never touched) and
assert that the corresponding test goes red. If one ever reports `GREEN (BAD)`,
that test has become decoration and is no longer protecting anything.

The defects they simulate are the ones that would actually happen:

| Mutation | What it would cost in production |
|---|---|
| Drop the 204 already-member branch | Every buyer who already joined the free server pays and gets nothing |
| Swallow a failed role grant | Buyer's code is burned with no access, and they cannot retry |
| Never delete the OAuth `state` | The callback can be replayed |
| Never store the `state` | The callback can be forged |
| Disable the timestamp tolerance | Captured webhooks can be replayed forever |
| Honour the `v0` signature scheme | Signature downgrade attack |
| Make verification always succeed | Anyone can forge a purchase and mint themselves access |
| Swallow a fulfilment failure | Stripe never retries, buyer is charged and never emailed |
| Mint a fresh code on every retry | One buyer gets two links, the first one dies |
| Skip role removal on refund | Refund and keep access forever |

## What these do NOT cover

- **The Discord consent screen.** It needs a real logged-in session, so it cannot
  be driven headless. Both redirect legs and every API call are asserted, but the
  human click is verified by hand.
- **Real Stripe and real Resend.** Both are mocked. Use
  `stripe listen --forward-to localhost:8788/api/stripe-webhook` with a real
  test-mode purchase (card `4242 4242 4242 4242`) for the live path, and note
  that `stripe trigger` is not a substitute: its synthetic event carries no real
  `customer_details.email`, which is the one field fulfilment depends on.
