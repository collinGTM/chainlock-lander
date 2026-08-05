// Direct tests of the claim flow's two Pages Functions.
//
// The real source files are loaded verbatim (read from disk, imported as a data
// URL) so there is no copy to drift out of step with what actually deploys.
import { readFile } from "node:fs/promises";

const SITE = new URL("../site", import.meta.url).pathname;

async function load(rel) {
  const src = await readFile(`${SITE}/${rel}`, "utf8");
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

// ---- tiny in-memory stand-in for a KV binding ----
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

const BASE_ENV = {
  DISCORD_CLIENT_ID: "clientid123",
  DISCORD_CLIENT_SECRET: "secret456",
  DISCORD_BOT_TOKEN: "bottoken789",
  DISCORD_GUILD_ID: "guild111",
  DISCORD_PAID_ROLE_ID: "role222",
  SITE_ORIGIN: "https://chainlock.gg",
};

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}${detail ? "  :: " + detail : ""}`); }
}

const claimStart = await load("functions/claim/index.js");
const claimCb = await load("functions/claim/callback.js");

// ============ leg one: /claim ============
{
  const MEMBERS = makeKV({
    "claim:goodcode": JSON.stringify({ email: "buyer@example.com", used: false }),
    "claim:usedcode": JSON.stringify({ email: "b@e.com", used: true }),
    "claim:revokedcode": JSON.stringify({ email: "b@e.com", used: false, revoked: true }),
  });
  const env = { ...BASE_ENV, MEMBERS };
  const call = (url) => claimStart.onRequestGet({ request: new Request(url), env });

  const r = await call("https://chainlock.gg/claim?code=goodcode");
  check("valid code redirects (302)", r.status === 302, `got ${r.status}`);
  const loc = new URL(r.headers.get("location"));
  check("redirect targets Discord authorize", loc.host === "discord.com" && loc.pathname === "/oauth2/authorize", loc.href);
  check("client_id passed through", loc.searchParams.get("client_id") === "clientid123");
  check("redirect_uri matches registered callback",
    loc.searchParams.get("redirect_uri") === "https://chainlock.gg/claim/callback",
    loc.searchParams.get("redirect_uri"));
  check("requests identify + guilds.join",
    loc.searchParams.get("scope") === "identify guilds.join",
    loc.searchParams.get("scope"));

  const state = loc.searchParams.get("state");
  check("state param present and non-trivial", !!state && state.length >= 24, state);
  const stored = await MEMBERS.get("state:" + state);
  check("state persisted to KV and maps back to the claim code",
    stored && JSON.parse(stored).code === "goodcode", stored);

  check("used code rejected with 409", (await call("https://chainlock.gg/claim?code=usedcode")).status === 409);
  check("revoked code rejected with 409", (await call("https://chainlock.gg/claim?code=revokedcode")).status === 409);
  check("unknown code rejected with 404", (await call("https://chainlock.gg/claim?code=nope")).status === 404);
  check("missing code rejected with 400", (await call("https://chainlock.gg/claim")).status === 400);

  // Two runs must not collide.
  const a = new URL((await call("https://chainlock.gg/claim?code=goodcode")).headers.get("location"));
  const b = new URL((await call("https://chainlock.gg/claim?code=goodcode")).headers.get("location"));
  check("each start mints a distinct state", a.searchParams.get("state") !== b.searchParams.get("state"));
}

// ============ leg two: /claim/callback ============
// Mocks Discord. `memberStatus` is the knob that matters: 201 = we added them,
// 204 = they were already in the guild and `roles` was IGNORED.
function mockDiscord({ memberStatus = 201, roleStatus = 204 } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "user-token-abc" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/users/@me")) {
      return new Response(JSON.stringify({ id: "user999", username: "buyer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (/\/members\/user999\/roles\//.test(u)) return new Response(null, { status: roleStatus });
    if (/\/members\/user999$/.test(u)) return new Response(null, { status: memberStatus });
    throw new Error("unexpected fetch: " + u);
  };
  return calls;
}

async function runCallback({ memberStatus, roleStatus }) {
  const MEMBERS = makeKV({
    "state:st123": JSON.stringify({ code: "goodcode" }),
    "claim:goodcode": JSON.stringify({ email: "buyer@example.com", used: false }),
    "member:buyer@example.com": JSON.stringify({ code: "goodcode", claimed: false }),
  });
  const env = { ...BASE_ENV, MEMBERS };
  const calls = mockDiscord({ memberStatus, roleStatus });
  const res = await claimCb.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?code=oauthcode&state=st123"),
    env,
  });
  return { res, calls, MEMBERS };
}

// --- the common case: buyer already joined the free server ---
{
  const { res, calls, MEMBERS } = await runCallback({ memberStatus: 204, roleStatus: 204 });
  check("204 already-member still ends in a redirect", res.status === 302, `got ${res.status}`);
  check("204 already-member lands them in the guild",
    (res.headers.get("location") || "").includes("discord.com/channels/guild111"),
    res.headers.get("location"));

  const roleCall = calls.find((c) => /\/members\/user999\/roles\/role222$/.test(c.url));
  check("204 already-member TRIGGERS the follow-up add-role call (the critical gotcha)",
    !!roleCall && roleCall.method === "PUT",
    "no PUT to /members/user999/roles/role222 was made");

  const claim = JSON.parse(await MEMBERS.get("claim:goodcode"));
  check("claim code burned after success", claim.used === true);
  check("discord_user_id recorded (enables refund revocation)", claim.discord_user_id === "user999");
  const member = JSON.parse(await MEMBERS.get("member:buyer@example.com"));
  check("member record marked claimed with the user id",
    member.claimed === true && member.discord_user_id === "user999");
  check("state consumed so the callback cannot be replayed",
    (await MEMBERS.get("state:st123")) === null);
}

// --- the fresh-account case ---
{
  const { res, calls } = await runCallback({ memberStatus: 201, roleStatus: 204 });
  check("201 new member ends in a redirect", res.status === 302, `got ${res.status}`);
  const addCall = calls.find((c) => /\/members\/user999$/.test(c.url));
  check("201 path sends the role inside the add-member body",
    addCall && JSON.parse(addCall.body).roles[0] === "role222",
    addCall && addCall.body);
  const roleCall = calls.find((c) => /\/roles\/role222$/.test(c.url));
  check("201 path does not need the redundant follow-up call", !roleCall);
}

// --- role assignment refused (bot role below the paid role) ---
{
  const { res, MEMBERS } = await runCallback({ memberStatus: 204, roleStatus: 403 });
  check("403 on add-role surfaces an error page, not a redirect", res.status === 502, `got ${res.status}`);
  const body = await res.text();
  check("403 error page tells them their code is still valid", /still valid/i.test(body));
  const claim = JSON.parse(await MEMBERS.get("claim:goodcode"));
  check("code NOT burned when the role could not be granted", claim.used !== true,
    "code was consumed despite the grant failing, so the buyer could not retry");
}

// --- replay protection ---
{
  mockDiscord({});
  const MEMBERS = makeKV({ "claim:goodcode": JSON.stringify({ used: false }) });
  const res = await claimCb.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?code=oauthcode&state=unknownstate"),
    env: { ...BASE_ENV, MEMBERS },
  });
  check("callback with an unknown state is refused", res.status === 400, `got ${res.status}`);
}

// --- user pressed Cancel ---
{
  mockDiscord({});
  const res = await claimCb.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?error=access_denied&state=st123"),
    env: { ...BASE_ENV, MEMBERS: makeKV() },
  });
  check("declined consent is handled gracefully", res.status === 400, `got ${res.status}`);
  check("declined consent says nothing was charged/changed", /nothing changed/i.test(await res.text()));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED: " + failures.join(", ")); process.exit(1); }
