// VERIFY.md section 5, applied to the webhook. Each case reintroduces a real
// defect in memory and asserts the matching test goes RED. The repo file is
// never modified.
import { readFile } from "node:fs/promises";

const SITE = new URL("../site", import.meta.url).pathname;
const PATH = `${SITE}/functions/api/stripe-webhook.js`;
const SECRET = "whsec_test_secret_value";
const original = await readFile(PATH, "utf8");

async function mutated(fn) {
  const src = fn(original);
  if (src === original) throw new Error("mutation changed nothing");
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

const enc = new TextEncoder();
async function hmacHex(body, secret, ts) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ts + "." + body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const nowSec = () => Math.floor(Date.now() / 1000);

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); } };
}
const BASE_ENV = () => ({
  STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test",
  MEMBER_FROM_EMAIL: "a@chainlock.gg", SITE_ORIGIN: "https://chainlock.gg",
  DISCORD_BOT_TOKEN: "bot", DISCORD_GUILD_ID: "guild111", DISCORD_PAID_ROLE_ID: "role222",
});
function mockNet({ resendOk = true } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.includes("api.resend.com"))
      return resendOk ? new Response("{}", { status: 200 }) : new Response("nope", { status: 429 });
    return new Response(null, { status: 204 });
  };
  return calls;
}
const sessionEvent = (o = {}) => ({
  id: o.eventId || "evt_x", type: "checkout.session.completed",
  data: { object: {
    id: o.sessionId || "cs_1", payment_status: "paid", payment_intent: "pi_1",
    amount_total: 2500, currency: "usd",
    customer_details: { email: "buyer@example.com" } } },
});
async function post(mod, env, event) {
  const body = JSON.stringify(event);
  const ts = nowSec();
  const headers = { "stripe-signature": `t=${ts},v1=${await hmacHex(body, SECRET, ts)}` };
  return mod.onRequestPost({ request: new Request("https://x/api/stripe-webhook", { method: "POST", body, headers }), env });
}

const results = [];
function expectRed(label, wentRed, detail) {
  results.push({ label, wentRed });
  console.log(`${wentRed ? "RED (good)  " : "GREEN (BAD) "} ${label}${detail ? "  :: " + detail : ""}`);
}

// 1. Replay window disabled.
{
  const mod = await mutated((s) =>
    s.replace("if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {", "if (false) { // MUTATED")
  );
  const body = '{"a":1}';
  const stale = `t=${nowSec() - 600},v1=${await hmacHex(body, SECRET, nowSec() - 600)}`;
  const r = await mod.verifySignature(body, stale, SECRET);
  expectRed("'stale timestamp' test detects a disabled replay window", r.ok,
    r.ok ? "stale signature accepted, assertion fails as it should" : "still rejected, test proves nothing");
}

// 2. Scheme downgrade: v0 honoured.
{
  const mod = await mutated((s) => s.replace('else if (k === "v1") v1s.push(v);', 'else if (k === "v1" || k === "v0") v1s.push(v); // MUTATED'));
  const body = '{"a":1}';
  const ts = nowSec();
  const r = await mod.verifySignature(body, `t=${ts},v0=${await hmacHex(body, SECRET, ts)}`, SECRET);
  expectRed("'v0-only rejected' test detects a scheme downgrade", r.ok,
    r.ok ? "v0 accepted, assertion fails as it should" : "still rejected, test proves nothing");
}

// 3. Verification that always succeeds.
{
  const mod = await mutated((s) => s.replace('return { ok: false, reason: "no matching v1 signature" };', "return { ok: true }; // MUTATED"));
  const r = await mod.verifySignature('{"tampered":true}', `t=${nowSec()},v1=00`, SECRET);
  expectRed("'tampered body rejected' test detects a rubber-stamp verifier", r.ok,
    r.ok ? "forged body accepted, assertion fails as it should" : "still rejected, test proves nothing");
}

// 4. Fulfilment failure swallowed: returns 200 and marks the event done, so the
//    retry never comes and the buyer is never emailed.
{
  const mod = await mutated((s) => s.replace("      if (!result.ok) {", "      if (false) { // MUTATED: swallow failure"));
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  mockNet({ resendOk: false });
  const r = await post(mod, env, sessionEvent({ eventId: "evt_swallow", sessionId: "cs_swallow" }));
  const marker = await env.MEMBERS.get("evt:evt_swallow");
  expectRed("'email failure returns 500' + 'no dedupe marker' tests detect a swallowed failure",
    r.status === 200 && marker !== null,
    `status ${r.status}, marker ${marker === null ? "absent" : "written"}`);
}

// 5. A fresh code minted on every retry, so one buyer gets two different links
//    and the first one they clicked stops being the live one.
{
  const mod = await mutated((s) => s.replace('let code = await env.MEMBERS.get("sess:" + session.id);', "let code = null; // MUTATED"));
  const env = { ...BASE_ENV(), MEMBERS: makeKV() };
  mockNet();
  await post(mod, env, sessionEvent({ eventId: "evt_a", sessionId: "cs_dup" }));
  const first = await env.MEMBERS.get("sess:cs_dup");
  await post(mod, env, sessionEvent({ eventId: "evt_b", sessionId: "cs_dup" }));
  const second = await env.MEMBERS.get("sess:cs_dup");
  expectRed("'same session never mints a second code' test detects code churn on retry",
    first !== second, `${first} -> ${second}`);
}

// 6. Refund that never pulls the role.
{
  const mod = await mutated((s) => s.replace("  if (!userId) {", "  if (true) { // MUTATED: never revoke"));
  const MEMBERS = makeKV({
    "pi:pi_1": "buyer@example.com",
    "member:buyer@example.com": JSON.stringify({ code: "c1", claimed: true, discord_user_id: "user999" }),
    "claim:c1": JSON.stringify({ used: true }),
  });
  const env = { ...BASE_ENV(), MEMBERS };
  const calls = mockNet();
  const body = JSON.stringify({ id: "evt_r", type: "charge.refunded", data: { object: { payment_intent: "pi_1" } } });
  const ts = nowSec();
  await mod.onRequestPost({
    request: new Request("https://x/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": `t=${ts},v1=${await hmacHex(body, SECRET, ts)}` } }),
    env,
  });
  const del = calls.find((c) => c.method === "DELETE" && c.url.includes("/roles/"));
  expectRed("'refund DELETEs the paid role' test detects a refund that grants free access forever",
    !del, del ? "role still removed, test proves nothing" : "no DELETE issued, assertion fails as it should");
}

const decorative = results.filter((r) => !r.wentRed);
console.log(`\n${results.length - decorative.length}/${results.length} webhook guards proven able to fail.` +
  (decorative.length ? `\nDECORATIVE: ${decorative.map((d) => d.label).join(", ")}` : ""));
process.exit(decorative.length ? 1 : 0);
