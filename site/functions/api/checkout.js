// POST /api/checkout — creates a Stripe Checkout Session for Wolf Den access
// (Cloudflare Pages Function).
//
// Zero dependencies by design. This repo has no package.json and no bundler,
// and CLAUDE.md documents two separate incidents where the Functions bundle
// silently failed to ship. Talking to Stripe over raw fetch keeps the deploy
// command byte-for-byte unchanged, so neither trap can be reintroduced here.
//
// No Stripe.js runs on the page: the browser POSTs here, gets back a hosted
// checkout URL and navigates to it. Card data never touches this origin, which
// is also why _headers needed no CSP change for a script origin.
//
// Bindings expected on the Pages project:
//   STRIPE_SECRET_KEY — secret. WITHOUT IT THIS ENDPOINT ANSWERS 503 on purpose,
//                       and the page shows an honest error instead of a dead
//                       button. That is what lets the site deploy and be
//                       verified before Stripe is configured at all.
//   STRIPE_PRICE_ID   — the $25 one-time price.
//   SITE_ORIGIN       — e.g. https://chainlock.gg. Falls back to the request's
//                       own origin so `wrangler pages dev` works unconfigured.

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // Staged-rollout behaviour, matching the precedent the old subscribe.js set:
    // missing config degrades to a clean refusal, never a stack trace.
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
      return json({ ok: false, error: "checkout unavailable" }, 503);
    }

    // Trailing slashes would produce "https://chainlock.gg//success".
    const origin = String(env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/+$/, "");

    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("line_items[0][price]", env.STRIPE_PRICE_ID);
    form.set("line_items[0][quantity]", "1");
    // Always create a Customer. Costs nothing and makes refunds and support
    // lookups sane later, when all we have is an email address.
    form.set("customer_creation", "always");
    form.set("success_url", origin + "/success");
    form.set("cancel_url", origin + "/");

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.STRIPE_SECRET_KEY,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const session = await res.json();
    if (!res.ok || !session.url) {
      // Stripe's error text can name the account, the price, or the key mode.
      // Log it for us, return something generic to the browser.
      console.log("stripe checkout failed", res.status, JSON.stringify(session && session.error));
      return json({ ok: false, error: "checkout failed" }, 502);
    }

    return json({ ok: true, url: session.url });
  } catch (err) {
    console.log("checkout error", err && err.message);
    return json({ ok: false, error: "server error" }, 500);
  }
}

// Anything other than POST gets a 405, matching the convention the rest of the
// project's endpoints use.
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "method not allowed" }, 405);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
