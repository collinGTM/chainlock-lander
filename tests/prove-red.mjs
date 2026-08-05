// VERIFY.md section 5: prove the guards actually go red against unfixed code.
//
// Each case below mutates the real source in memory to reintroduce a specific
// defect, then asserts the corresponding test FAILS. The repo file is never
// modified. If a mutation does not turn its test red, that test is decoration.
import { readFile } from "node:fs/promises";

const SITE = new URL("../site", import.meta.url).pathname;

async function loadMutated(rel, mutate) {
  const original = await readFile(`${SITE}/${rel}`, "utf8");
  const src = mutate(original);
  if (src === original) throw new Error(`mutation for ${rel} did not change anything`);
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
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

function mockDiscord({ memberStatus = 204, roleStatus = 204 } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.endsWith("/oauth2/token"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.endsWith("/users/@me"))
      return new Response(JSON.stringify({ id: "user999" }), { status: 200, headers: { "content-type": "application/json" } });
    if (/\/members\/user999\/roles\//.test(u)) return new Response(null, { status: roleStatus });
    if (/\/members\/user999$/.test(u)) return new Response(null, { status: memberStatus });
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}

const results = [];
function expectRed(label, wentRed, detail) {
  results.push({ label, wentRed });
  console.log(`${wentRed ? "RED (good)  " : "GREEN (BAD) "} ${label}${detail ? "  :: " + detail : ""}`);
}

// ---------------------------------------------------------------------------
// 1. The 204 already-member gotcha. Naive implementation trusts the `roles`
//    field in the add-member body, which Discord ignores for existing members.
// ---------------------------------------------------------------------------
{
  const mod = await loadMutated("functions/claim/callback.js", (s) =>
    s.replace("if (addRes.status === 204) {", "if (false) { // MUTATED: naive impl trusts add-member roles")
  );
  const MEMBERS = makeKV({
    "state:st123": JSON.stringify({ code: "goodcode" }),
    "claim:goodcode": JSON.stringify({ email: "b@e.com", used: false }),
  });
  const calls = mockDiscord({ memberStatus: 204 });
  await mod.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?code=c&state=st123"),
    env: { ...BASE_ENV, MEMBERS },
  });
  const roleCall = calls.find((c) => /\/roles\/role222$/.test(c.url));
  expectRed(
    "204 gotcha test detects a missing follow-up add-role call",
    !roleCall,
    roleCall ? "role call still happened, test would NOT catch the bug" : "no role call, so the assertion fails as it should"
  );
}

// ---------------------------------------------------------------------------
// 2. Burning the claim code even when the role grant failed. That would strand
//    a paying buyer with a dead code and no access.
// ---------------------------------------------------------------------------
{
  const mod = await loadMutated("functions/claim/callback.js", (s) =>
    s.replace(
      `        return page(
          "Could not grant the role",`,
      `        /* MUTATED: swallow the failure and carry on */ if (false) return page(
          "Could not grant the role",`
    )
  );
  const MEMBERS = makeKV({
    "state:st123": JSON.stringify({ code: "goodcode" }),
    "claim:goodcode": JSON.stringify({ email: "b@e.com", used: false }),
  });
  mockDiscord({ memberStatus: 204, roleStatus: 403 });
  await mod.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?code=c&state=st123"),
    env: { ...BASE_ENV, MEMBERS },
  });
  const claim = JSON.parse(await MEMBERS.get("claim:goodcode"));
  expectRed(
    "'code not burned on failure' test detects a swallowed grant failure",
    claim.used === true,
    claim.used === true ? "code was burned, so the assertion fails as it should" : "code survived, test would NOT catch it"
  );
}

// ---------------------------------------------------------------------------
// 3. Replay protection. If state is never deleted, the same callback URL can be
//    replayed.
// ---------------------------------------------------------------------------
{
  const mod = await loadMutated("functions/claim/callback.js", (s) =>
    s.replace('await env.MEMBERS.delete("state:" + state);', "/* MUTATED: state never consumed */")
  );
  const MEMBERS = makeKV({
    "state:st123": JSON.stringify({ code: "goodcode" }),
    "claim:goodcode": JSON.stringify({ email: "b@e.com", used: false }),
  });
  mockDiscord({ memberStatus: 201 });
  await mod.onRequestGet({
    request: new Request("https://chainlock.gg/claim/callback?code=c&state=st123"),
    env: { ...BASE_ENV, MEMBERS },
  });
  const stillThere = await MEMBERS.get("state:st123");
  expectRed(
    "'state consumed' test detects missing replay protection",
    stillThere !== null,
    stillThere !== null ? "state survived, so the assertion fails as it should" : "state gone, test would NOT catch it"
  );
}

// ---------------------------------------------------------------------------
// 4. CSRF state validation on leg one. If state is never persisted, the
//    callback can be forged.
// ---------------------------------------------------------------------------
{
  const mod = await loadMutated("functions/claim/index.js", (s) =>
    s.replace(/await env\.MEMBERS\.put\(\s*"state:" \+ state,/, "if (false) await env.MEMBERS.put(\n      \"state:\" + state,")
  );
  const MEMBERS = makeKV({ "claim:goodcode": JSON.stringify({ used: false }) });
  const res = await mod.onRequestGet({
    request: new Request("https://chainlock.gg/claim?code=goodcode"),
    env: { ...BASE_ENV, MEMBERS },
  });
  const state = new URL(res.headers.get("location")).searchParams.get("state");
  const stored = await MEMBERS.get("state:" + state);
  expectRed(
    "'state persisted' test detects a state that is never stored",
    stored === null,
    stored === null ? "nothing stored, so the assertion fails as it should" : "still stored, test would NOT catch it"
  );
}

const decorative = results.filter((r) => !r.wentRed);
console.log(
  `\n${results.length - decorative.length}/${results.length} guards proven able to fail.` +
    (decorative.length ? `\nDECORATIVE (prove nothing): ${decorative.map((d) => d.label).join(", ")}` : "")
);
process.exit(decorative.length ? 1 : 0);
