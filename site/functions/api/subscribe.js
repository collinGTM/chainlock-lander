// POST /api/subscribe — Chainlock launch-list endpoint (Cloudflare Pages Function)
//
// Bindings expected on the Pages project (both optional for staged rollout):
//   SIGNUPS          — KV namespace binding. Without it, submissions succeed but store nothing.
//   TURNSTILE_SECRET — secret env var. Without it, Turnstile verification is skipped
//                      (honeypot + validation still run). Add it when you paste the
//                      site key into index.html.

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return json({ ok: false, error: "bad request" }, 400);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: "bad request" }, 400); }

    const email = String(body.email || "").trim().toLowerCase();
    const honeypot = String(body.company || "");
    const token = String(body.token || "");

    // Bots that fill the hidden field get a fake success and nothing is stored.
    if (honeypot) return json({ ok: true });

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return json({ ok: false, error: "invalid email" }, 400);
    }

    if (env.TURNSTILE_SECRET) {
      if (!token) return json({ ok: false, error: "verification required" }, 400);
      const form = new FormData();
      form.append("secret", env.TURNSTILE_SECRET);
      form.append("response", token);
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) form.append("remoteip", ip);
      const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form,
      });
      const vj = await vr.json();
      if (!vj.success) return json({ ok: false, error: "verification failed" }, 403);
    }

    if (env.SIGNUPS) {
      // Email as key = free dedupe. Stored value stays minimal: timestamp + country.
      const existing = await env.SIGNUPS.get(email);
      if (existing === null) {
        await env.SIGNUPS.put(
          email,
          JSON.stringify({ ts: Date.now(), country: (request.cf && request.cf.country) || null })
        );
      }
    }

    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "server error" }, 500);
  }
}

// Anything other than POST gets a 405.
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
