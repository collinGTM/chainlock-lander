// Tests for functions/api/stripe-webhook.js, loaded verbatim from disk.
import { readFile } from "node:fs/promises";

const SITE = new URL("../site", import.meta.url).pathname;
const SECRET = "whsec_test_secret_value";

const src = await readFile(`${SITE}/functions/api/stripe-webhook.js`, "utf8");
const wh = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}${detail ? "  :: " + detail : ""}`); }
}

const enc = new TextEncoder();
async function hmacHex(body, secret, ts) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ts + "." + body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const nowSec = () => Math.floor(Date.now() / 1000);
async function sigHeader(body, { secret = SECRET, ts = nowSec(), scheme = "v1" } = {}) {
  return `t=${ts},${scheme}=${await hmacHex(body, secret, ts)}`;
}

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

const BASE_ENV = () => ({
  STRIPE_WEBHOOK_SECRET: SECRET,
  RESEND_API_KEY: "re_test",
  MEMBER_FROM_EMAIL: "Chainlock <access@chainlock.gg>",
  SITE_ORIGIN: "https://chainlock.gg",
  DISCORD_BOT_TOKEN: "bot",
  DISCORD_GUILD_ID: "guild111",
  DISCORD_PAID_ROLE_ID: "role222",
});

function mockNet({ resendOk = true } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.includes("api.resend.com")) {
      return resendOk
        ? new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("rate limited", { status: 429 });
    }
    if (u.includes("discord.com")) return new Response(null, { status: 204 });
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}

function sessionEvent(over = {}) {
  return {
    id: over.eventId || "evt_" + Math.random().toString(16).slice(2),
    type: "checkout.session.completed",
    data: {
      object: {
        id: over.sessionId || "cs_test_123",
        payment_status: over.payment_status || "paid",
        payment_intent: over.payment_intent === undefined ? "pi_test_123" : over.payment_intent,
        amount_total: 2500,
        currency: "usd",
        customer_details: { email: over.email === undefined ? "Buyer@Example.com" : over.email },
      },
    },
  };
}

async function post(env, event, headerOverride) {
  const body = JSON.stringify(event);
  const headers = { "stripe-signature": headerOverride !== undefined ? headerOverride : await sigHeader(body) };
  return wh.onRequestPost({ request: new Request("https://chainlock.gg/api/stripe-webhook", { method: "POST", body, headers }), env });
}

// ============================ signature ============================
{
  const body = '{"id":"evt_1","type":"ping"}';

  check("valid signature verifies", (await wh.verifySignature(body, await sigHeader(body), SECRET)).ok);

  const good = await sigHeader(body);
  const tampered = await wh.verifySignature(body.replace("ping", "pong"), good, SECRET);
  check("tampered body is rejected", !tampered.ok, tampered.reason);

  const stale = await wh.verifySignature(body, await sigHeader(body, { ts: nowSec() - 600 }), SECRET);
  check("stale timestamp is rejected", !stale.ok, stale.reason);

  const future = await wh.verifySignature(body, await sigHeader(body, { ts: nowSec() + 600 }), SECRET);
  check("far-future timestamp is rejected", !future.ok, future.reason);

  const v0only = await wh.verifySignature(body, await sigHeader(body, { scheme: "v0" }), SECRET);
  check("v0-only header is rejected (no scheme downgrade)", !v0only.ok, v0only.reason);

  const wrongSecret = await wh.verifySignature(body, await sigHeader(body, { secret: "whsec_other" }), SECRET);
  check("signature from a different secret is rejected", !wrongSecret.ok, wrongSecret.reason);

  check("missing header is rejected", !(await wh.verifySignature(body, null, SECRET)).ok);
  check("garbage header is rejected", !(await wh.verifySignature(body, "not-a-signature", SECRET)).ok);
  check("non-numeric timestamp is rejected", !(await wh.verifySignature(body, "t=abc,v1=00", SECRET)).ok);
  check("odd-length hex is rejected", !(await wh.verifySignature(body, `t=${nowSec()},v1=abc`, SECRET)).ok);

  // Stripe sends several v1 values while a secret is being rotated.
  const ts = nowSec();
  const rotating = `t=${ts},v1=${await hmacHex(body, "whsec_old", ts)},v1=${await hmacHex(body, SECRET, ts)}`;
  check("accepts one matching v1 among several (secret rotation)", (await wh.verifySignature(body, rotating, SECRET)).ok);
}

// ============================ endpoint gating ============================
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  mockNet();
  const r = await post(env, sessionEvent(), "t=1,v1=deadbeef");
  check("bad signature returns 400", r.status === 400, String(r.status));
  check("bad signature fulfils nothing", env.MEMBERS._m.size === 0, `${env.MEMBERS._m.size} keys written`);

  const noSecret = { ...BASE_ENV(), STRIPE_WEBHOOK_SECRET: undefined, MEMBERS: makeKV() };
  const r2 = await post(noSecret, sessionEvent());
  check("missing webhook secret returns 500, not a false 200", r2.status === 500, String(r2.status));

  const r3 = await wh.onRequest({ request: new Request("https://chainlock.gg/api/stripe-webhook"), env });
  check("GET returns 405", r3.status === 405, String(r3.status));
}

// ============================ fulfilment ============================
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  const calls = mockNet();
  const ev = sessionEvent();
  const r = await post(env, ev);
  check("paid session returns 200", r.status === 200, String(r.status));

  const code = await env.MEMBERS.get("sess:cs_test_123");
  check("claim code minted and keyed to the session", !!code && code.length === 32, code);

  const claim = JSON.parse(await env.MEMBERS.get("claim:" + code));
  check("claim record stores a lowercased email", claim.email === "buyer@example.com", claim.email);
  check("claim starts unused", claim.used === false);
  check("member record written", !!(await env.MEMBERS.get("member:buyer@example.com")));
  check("payment_intent maps back to the email (refund path)",
    (await env.MEMBERS.get("pi:pi_test_123")) === "buyer@example.com");

  const email = calls.find((c) => c.url.includes("api.resend.com"));
  check("access email sent via Resend", !!email);
  const payload = JSON.parse(email.body);
  check("email addressed to the buyer", payload.to[0] === "buyer@example.com", payload.to[0]);
  check("email contains the claim link", payload.html.includes("/claim?code=" + code));
  check("email has a plain-text alternative", typeof payload.text === "string" && payload.text.includes(code));

  // --- retry of the SAME event: deduped ---
  const before = calls.length;
  const again = await post(env, ev);
  check("replayed event is deduped", again.status === 200 && (await again.json()).deduped === true);
  check("replayed event sends no second email", calls.length === before, `${calls.length - before} extra calls`);

  // --- a DIFFERENT event id for the same session reuses the code ---
  const ev2 = sessionEvent({ eventId: "evt_different", sessionId: "cs_test_123" });
  await post(env, ev2);
  check("same session never mints a second code",
    (await env.MEMBERS.get("sess:cs_test_123")) === code,
    "code changed on retry, buyer would get two different links");
}

// --- unpaid session ---
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  const calls = mockNet();
  const r = await post(env, sessionEvent({ payment_status: "unpaid", sessionId: "cs_unpaid" }));
  check("unpaid session is acknowledged but not fulfilled", r.status === 200);
  check("unpaid session mints no code", (await env.MEMBERS.get("sess:cs_unpaid")) === null);
  check("unpaid session sends no email", !calls.some((c) => c.url.includes("resend")));
}

// --- no email address on the session ---
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  const calls = mockNet();
  const r = await post(env, sessionEvent({ email: null, sessionId: "cs_noemail" }));
  check("session with no email is acknowledged rather than retried forever", r.status === 200);
  check("session with no email sends nothing", !calls.some((c) => c.url.includes("resend")));
}

// --- Resend down: Stripe must retry, and the code must survive ---
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  mockNet({ resendOk: false });
  const r = await post(env, sessionEvent({ sessionId: "cs_mailfail", eventId: "evt_mailfail" }));
  check("email failure returns 500 so Stripe retries", r.status === 500, String(r.status));
  check("email failure does NOT write the dedupe marker",
    (await env.MEMBERS.get("evt:evt_mailfail")) === null,
    "marker written, so the retry would be swallowed and the buyer never emailed");
  const code = await env.MEMBERS.get("sess:cs_mailfail");
  check("code persisted despite the email failing", !!code);

  // The retry succeeds and reuses the same code.
  const calls = mockNet({ resendOk: true });
  const r2 = await post(env, sessionEvent({ sessionId: "cs_mailfail", eventId: "evt_mailfail" }));
  check("retry after an email failure succeeds", r2.status === 200);
  check("retry reuses the original code", (await env.MEMBERS.get("sess:cs_mailfail")) === code);
  const sentUrl = JSON.parse(calls.find((c) => c.url.includes("resend")).body).html;
  check("retry emails the same link", sentUrl.includes("/claim?code=" + code));
}

// ============================ refunds ============================
function refundEvent(pi = "pi_test_123") {
  return { id: "evt_refund_" + Math.random().toString(16).slice(2), type: "charge.refunded", data: { object: { payment_intent: pi } } };
}

// --- refund after the buyer claimed: role must be pulled ---
{
  const MEMBERS = makeKV({
    "pi:pi_test_123": "buyer@example.com",
    "member:buyer@example.com": JSON.stringify({ code: "abc123", claimed: true, discord_user_id: "user999" }),
    "claim:abc123": JSON.stringify({ email: "buyer@example.com", used: true }),
  });
  const env = { ...BASE_ENV(), MEMBERS };
  const calls = mockNet();
  const r = await post(env, refundEvent());
  check("refund returns 200", r.status === 200);

  const del = calls.find((c) => c.method === "DELETE" && /\/members\/user999\/roles\/role222$/.test(c.url));
  check("refund DELETEs the paid role", !!del, "no DELETE to the role endpoint");
  check("refund does not kick them from the guild (free tier survives)",
    !calls.some((c) => c.method === "DELETE" && /\/members\/user999$/.test(c.url)));

  const claim = JSON.parse(await MEMBERS.get("claim:abc123"));
  check("refund marks the claim revoked", claim.revoked === true);
  const member = JSON.parse(await MEMBERS.get("member:buyer@example.com"));
  check("member record marked refunded", member.refunded === true);
}

// --- refund before claiming: code must die so it cannot be redeemed ---
{
  const MEMBERS = makeKV({
    "pi:pi_unclaimed": "b2@example.com",
    "member:b2@example.com": JSON.stringify({ code: "xyz789", claimed: false }),
    "claim:xyz789": JSON.stringify({ email: "b2@example.com", used: false }),
  });
  const env = { ...BASE_ENV(), MEMBERS };
  const calls = mockNet();
  await post(env, refundEvent("pi_unclaimed"));
  const claim = JSON.parse(await MEMBERS.get("claim:xyz789"));
  check("refund kills an UNCLAIMED code (blocks refund-then-redeem)", claim.revoked === true);
  check("no Discord call when there is no user id yet", !calls.some((c) => c.url.includes("discord")));
}

// --- refund for something we never sold ---
{
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  mockNet();
  const r = await post(env, refundEvent("pi_unknown"));
  check("refund for an unknown payment is a safe no-op", r.status === 200);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED: " + failures.join(", ")); process.exit(1); }
