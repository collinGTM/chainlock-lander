// POST /api/stripe-webhook — fulfils a Wolf Den purchase (Cloudflare Pages Function).
//
// This is the only thing that grants access. The buyer reaching /success is
// cosmetic, so a closed tab or a failed redirect never costs anyone their access.
//
// Zero dependencies: signature verification is WebCrypto, everything else is
// raw fetch. See CLAUDE.md for why no npm package is allowed in here.
//
// Bindings expected on the Pages project:
//   MEMBERS               — KV. claim:/member:/sess:/pi:/evt: records.
//   STRIPE_WEBHOOK_SECRET — secret, from THIS endpoint in the Stripe dashboard.
//                           The value `stripe listen` prints locally is a
//                           different secret and will not verify production.
//   RESEND_API_KEY        — secret. Sends the access email.
//   MEMBER_FROM_EMAIL     — e.g. "Chainlock <access@chainlock.gg>".
//   SITE_ORIGIN           — builds the claim link.
//   DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_PAID_ROLE_ID
//                         — only needed to revoke a role on refund.

const TOLERANCE_SECONDS = 300; // Stripe's own default. Setting this to 0 would
                               // disable the recency check entirely.
const DISCORD_API = "https://discord.com/api/v10";

export async function onRequestPost(context) {
  const { request, env } = context;

  // The signature covers the raw bytes. Read text BEFORE parsing anything, or
  // verification becomes impossible.
  const rawBody = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Deliberately noisy. A 200 here would make Stripe consider a paid order
    // delivered while we silently dropped it.
    console.log("webhook rejected: STRIPE_WEBHOOK_SECRET is not configured");
    return json({ ok: false, error: "not configured" }, 500);
  }

  const verdict = await verifySignature(
    rawBody,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!verdict.ok) {
    console.log("webhook signature rejected:", verdict.reason);
    return json({ ok: false, error: "invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "bad payload" }, 400);
  }

  if (!env.MEMBERS) {
    console.log("webhook cannot fulfil: MEMBERS KV binding missing");
    return json({ ok: false, error: "not configured" }, 500);
  }

  try {
    // Stripe retries. Check first, and only write the marker once the work has
    // actually succeeded. Marking first would trade a duplicate email for a
    // silently lost fulfilment, which is much worse.
    const seen = await env.MEMBERS.get("evt:" + event.id);
    if (seen !== null) {
      return json({ ok: true, deduped: true });
    }

    if (event.type === "checkout.session.completed") {
      const result = await fulfil(env, event.data.object);
      if (!result.ok) {
        // Non-2xx makes Stripe retry. The claim code is already persisted
        // against the session, so a retry re-sends the same link rather than
        // minting a second one.
        console.log("fulfilment failed, asking Stripe to retry:", result.reason);
        return json({ ok: false, error: result.reason }, 500);
      }
    } else if (event.type === "charge.refunded") {
      await revoke(env, event.data.object);
    }
    // Anything else is acknowledged and ignored.

    await env.MEMBERS.put("evt:" + event.id, "1", { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true });
  } catch (err) {
    console.log("webhook handler error:", err && err.message);
    return json({ ok: false, error: "server error" }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Signature verification
//
// Stripe-Signature looks like: t=1492774577,v1=<hex>,v0=<hex>
// Signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret.
// Only the v1 scheme is honoured; accepting v0 would be a downgrade attack.
// ---------------------------------------------------------------------------
export async function verifySignature(rawBody, sigHeader, secret, nowSeconds) {
  if (!sigHeader) return { ok: false, reason: "missing signature header" };

  let timestamp = null;
  const v1s = [];
  for (const part of String(sigHeader).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") v1s.push(v);
  }

  if (!timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  if (v1s.length === 0) return { ok: false, reason: "no v1 signature present" };

  const now = typeof nowSeconds === "number" ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedPayload = enc.encode(timestamp + "." + rawBody);

  for (const hex of v1s) {
    const bytes = hexToBytes(hex);
    if (!bytes) continue;
    // crypto.subtle.verify is constant-time by construction, which is why this
    // is used instead of comparing hex strings by hand.
    if (await crypto.subtle.verify("HMAC", key, bytes, signedPayload)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no matching v1 signature" };
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  if (/[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------
async function fulfil(env, session) {
  // In payment mode an async payment method can complete the session while
  // still unpaid. Only "paid" is a sale.
  if (session.payment_status !== "paid") {
    console.log("session completed but not paid, ignoring:", session.id, session.payment_status);
    return { ok: true };
  }

  const email = String(
    (session.customer_details && session.customer_details.email) || session.customer_email || ""
  ).trim().toLowerCase();
  if (!email) {
    // Nothing to send to. Retrying will not conjure an address, so acknowledge
    // and shout, rather than looping for three days.
    console.log("paid session has no email address:", session.id);
    return { ok: true };
  }

  // Reuse the code if this session already produced one, so a Stripe retry
  // re-sends the same link instead of issuing a second code to one buyer.
  let code = await env.MEMBERS.get("sess:" + session.id);
  if (code === null) {
    code = randomHex(16);
    const now = Date.now();
    await env.MEMBERS.put(
      "claim:" + code,
      JSON.stringify({ email, session_id: session.id, used: false, ts: now })
    );
    await env.MEMBERS.put(
      "member:" + email,
      JSON.stringify({
        code,
        session_id: session.id,
        amount_total: session.amount_total,
        currency: session.currency,
        ts: now,
        claimed: false,
      })
    );
    await env.MEMBERS.put("sess:" + session.id, code);
    if (session.payment_intent) {
      // The refund handler's only way back from a charge to a buyer.
      await env.MEMBERS.put("pi:" + String(session.payment_intent), email);
    }
  }

  const origin = String(env.SITE_ORIGIN || "https://chainlock.gg").replace(/\/+$/, "");
  const claimUrl = origin + "/claim?code=" + code;

  if (!env.RESEND_API_KEY || !env.MEMBER_FROM_EMAIL) {
    console.log("cannot email access link, Resend is not configured. Code minted:", code);
    return { ok: false, reason: "email not configured" };
  }

  const sent = await sendAccessEmail(env, email, claimUrl);
  if (!sent.ok) return { ok: false, reason: "email send failed: " + sent.reason };

  console.log("fulfilled", session.id, "->", email);
  return { ok: true };
}

async function sendAccessEmail(env, to, claimUrl) {
  const html =
    '<div style="background:#0b0e14;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto;background:#121722;border:1px solid #33405a;border-radius:10px;padding:32px">' +
    '<p style="margin:0 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#5b6478">Payment received</p>' +
    '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#e8eaf2;font-weight:600">You&rsquo;re in. Here&rsquo;s your access link.</h1>' +
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#8a93a8">One click puts you in the Wolf Den with your paid role attached. The link works once, so keep this email until you have used it.</p>' +
    '<p style="margin:0 0 24px"><a href="' + claimUrl + '" style="display:inline-block;background:#e8eaf2;color:#0b0e14;text-decoration:none;font-weight:600;font-size:15px;padding:14px 24px;border-radius:6px">Claim your access</a></p>' +
    '<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b6478">If the button does not work, paste this into your browser:</p>' +
    '<p style="margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#8a93a8;word-break:break-all">' + claimUrl + "</p>" +
    '<p style="margin:0;padding-top:20px;border-top:1px solid #222b3d;font-size:13px;line-height:1.6;color:#5b6478">Trouble getting in? Just reply to this email and we will sort it out by hand.</p>' +
    "</div></div>";

  const text =
    "You're in. Here's your access link.\n\n" +
    "One click puts you in the Wolf Den with your paid role attached:\n" +
    claimUrl +
    "\n\nThe link works once, so keep this email until you have used it.\n" +
    "Trouble getting in? Reply to this email and we will sort it out by hand.\n";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.RESEND_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MEMBER_FROM_EMAIL,
        to: [to],
        subject: "Your Wolf Den access",
        html,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, reason: res.status + " " + detail.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || "network" };
  }
}

// ---------------------------------------------------------------------------
// Refunds
//
// JUDGMENT CALL, documented here rather than only in conversation: ANY refund
// on the charge revokes access, including a partial one. For a single $25
// one-time product a partial refund has no coherent "partial access" meaning,
// and the conservative, reversible choice is to pull the paid role (which can
// be re-granted by hand in seconds) rather than let a refunded buyer keep it.
// Revisit if tiered or multi-item pricing ever lands here.
//
// Free-channel access is deliberately NOT touched. They lose the paid role and
// keep the free tier, which is exactly the right outcome now the tiers differ.
// ---------------------------------------------------------------------------
async function revoke(env, charge) {
  const pi = charge && charge.payment_intent;
  if (!pi) return;

  const email = await env.MEMBERS.get("pi:" + String(pi));
  if (email === null) {
    console.log("refund for an unknown payment_intent, nothing to revoke:", pi);
    return;
  }

  const memberRaw = await env.MEMBERS.get("member:" + email);
  const member = memberRaw === null ? null : JSON.parse(memberRaw);

  // Kill the code so an unclaimed one cannot still be redeemed after a refund.
  if (member && member.code) {
    const claimRaw = await env.MEMBERS.get("claim:" + member.code);
    if (claimRaw !== null) {
      const claim = JSON.parse(claimRaw);
      claim.revoked = true;
      claim.revoked_ts = Date.now();
      await env.MEMBERS.put("claim:" + member.code, JSON.stringify(claim));
    }
  }

  const userId = member && member.discord_user_id;
  if (!userId) {
    console.log("refund revoked code but buyer never claimed, no role to pull:", email);
    return;
  }
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID || !env.DISCORD_PAID_ROLE_ID) {
    console.log("refund cannot pull the role, Discord is not configured. Do it by hand for:", email);
    return;
  }

  const res = await fetch(
    DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + userId +
      "/roles/" + env.DISCORD_PAID_ROLE_ID,
    { method: "DELETE", headers: { authorization: "Bot " + env.DISCORD_BOT_TOKEN } }
  );
  if (!res.ok) {
    console.log("refund could not remove the role", res.status, "for", email, "-> remove it by hand");
    return;
  }

  if (member) {
    member.refunded = true;
    member.refunded_ts = Date.now();
    await env.MEMBERS.put("member:" + email, JSON.stringify(member));
  }
  console.log("refund revoked paid role for", email);
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.prototype.map
    .call(b, function (x) { return x.toString(16).padStart(2, "0"); })
    .join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
