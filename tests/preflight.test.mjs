// Proves tests/preflight.mjs reports RED when the setup is wrong.
//
// A preflight that only ever passes is worse than none, because it would
// license taking real money. So every check gets driven against a mocked
// response where exactly one thing is broken, and must fail on that specific
// thing. The suite opens with an all-good scenario, otherwise "everything
// fails" would look like success.

import { checkDiscord, checkStripe, checkResend, checkDeployment, FAIL } from "./preflight.mjs";

const GUILD = "234567890123456789";
const PAID_ROLE = "345678901234567890";
const BOT_USER = "999888777666555444";
const BOT_ROLE = "111222333444555666";
const ORIGIN = "https://chainlock.gg";
const BOTH_PERMS = String(1n | (1n << 28n)); // Create Instant Invite + Manage Roles

const ENV = {
  DISCORD_BOT_TOKEN: "tok.tok.tok",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_PAID_ROLE_ID: PAID_ROLE,
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_PRICE_ID: "price_abc",
  RESEND_API_KEY: "re_abc",
  MEMBER_FROM_EMAIL: "Chainlock <access@chainlock.gg>",
  SITE_ORIGIN: ORIGIN,
};

// One knob per failure mode. Defaults are the fully-correct setup.
function mock(o = {}) {
  const {
    botTokenValid = true,
    guildFound = true,
    paidRoleExists = true,
    botRolePosition = 10,
    paidRolePosition = 5,
    botPerms = BOTH_PERMS,
    priceAmount = 2500,
    priceType = "one_time",
    priceActive = true,
    endpointUrl = ORIGIN + "/api/stripe-webhook",
    endpointEvents = ["checkout.session.completed", "charge.refunded"],
    endpointStatus = "enabled",
    endpointLivemode = false,
    extraEndpoints = [],
    resendStatus = "verified",
    resendDomain = "chainlock.gg",
    checkoutStatus = 200,
    checkoutBody = { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_123" },
  } = o;

  const J = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  return async (url, opts = {}) => {
    const u = String(url);

    if (u.endsWith("/users/@me")) {
      return botTokenValid ? J({ id: BOT_USER, username: "WolfDen" }) : J({ message: "401: Unauthorized" }, 401);
    }
    if (u.endsWith("/guilds/" + GUILD)) {
      return guildFound ? J({ id: GUILD, name: "The Wolf Den" }) : J({ message: "Unknown Guild" }, 404);
    }
    if (u.endsWith("/guilds/" + GUILD + "/roles")) {
      const roles = [
        { id: GUILD, name: "@everyone", position: 0, permissions: "0" },
        { id: BOT_ROLE, name: "Wolf Den Bot", position: botRolePosition, permissions: botPerms },
      ];
      if (paidRoleExists) roles.push({ id: PAID_ROLE, name: "Paid Access", position: paidRolePosition, permissions: "0" });
      return J(roles);
    }
    if (u.endsWith("/guilds/" + GUILD + "/members/" + BOT_USER)) {
      return J({ roles: [BOT_ROLE] });
    }
    if (u.includes("/v1/prices/")) {
      return J({ id: "price_abc", active: priceActive, type: priceType, unit_amount: priceAmount, currency: "usd" });
    }
    if (u.includes("/v1/webhook_endpoints")) {
      return J({ data: [
        { url: endpointUrl, status: endpointStatus, enabled_events: endpointEvents, livemode: endpointLivemode },
        ...extraEndpoints,
      ]});
    }
    if (u.includes("api.resend.com/domains")) {
      return J({ data: [{ name: resendDomain, status: resendStatus }] });
    }
    if (u.includes("/api/checkout")) {
      return checkoutStatus === 503
        ? J({ ok: false, error: "checkout unavailable" }, 503)
        : new Response(JSON.stringify(checkoutBody), { status: checkoutStatus, headers: { "content-type": "application/json" } });
    }
    throw new Error("unmocked fetch: " + u);
  };
}

let passed = 0;
const failures = [];

// Asserts the named check produces a FAIL whose label or fix mentions `expect`.
async function expectRed(name, fn, knobs, expect) {
  const results = await fn(ENV, mock(knobs));
  const fails = results.filter((r) => r.level === FAIL);
  const hit = fails.find((r) => (r.label + " " + r.detail + " " + (r.fix || "")).toLowerCase().includes(expect.toLowerCase()));
  if (hit) {
    console.log(`RED (good)   ${name}`);
    passed++;
  } else {
    console.log(`GREEN (BAD)  ${name}  :: expected a failure mentioning "${expect}", got ${fails.length} failure(s): ${fails.map((f) => f.label).join(", ") || "none"}`);
    failures.push(name);
  }
}

async function expectAllGreen(name, fn) {
  const results = await fn(ENV, mock());
  const fails = results.filter((r) => r.level === FAIL);
  if (fails.length === 0) {
    console.log(`GREEN (good) ${name}`);
    passed++;
  } else {
    console.log(`RED (BAD)    ${name}  :: ${fails.map((f) => f.label + " -> " + f.detail).join(" | ")}`);
    failures.push(name);
  }
}

console.log("=== a correct setup must pass, or nothing below means anything ===");
await expectAllGreen("Discord, fully correct", checkDiscord);
await expectAllGreen("Stripe, fully correct", checkStripe);
await expectAllGreen("Resend, fully correct", checkResend);
await expectAllGreen("Deployment, fully correct", checkDeployment);

console.log("\n=== Discord failure modes ===");
await expectRed("invalid bot token", checkDiscord, { botTokenValid: false }, "bot token");
await expectRed("guild id is wrong / bot not in server", checkDiscord, { guildFound: false }, "channel id");
await expectRed("paid role id does not exist", checkDiscord, { paidRoleExists: false }, "paid role");
await expectRed("BOT ROLE BELOW PAID ROLE (the silent one)", checkDiscord,
  { botRolePosition: 2, paidRolePosition: 5 }, "drag the bot's role above");
await expectRed("bot role equal position to paid role", checkDiscord,
  { botRolePosition: 5, paidRolePosition: 5 }, "outranks");
await expectRed("missing Manage Roles", checkDiscord, { botPerms: "1" }, "no paid access");
await expectRed("missing Create Instant Invite", checkDiscord, { botPerms: String(1n << 28n) }, "cannot be added at all");
await expectRed("missing both permissions", checkDiscord, { botPerms: "0" }, "268435457");

console.log("\n=== Administrator is genuinely sufficient, not a failure ===");
{
  const results = await checkDiscord(ENV, mock({ botPerms: "8" }));
  const permFail = results.filter((r) => r.level === FAIL && r.label.includes("permissions"));
  if (permFail.length === 0) { console.log("GREEN (good) Administrator satisfies both permission bits"); passed++; }
  else { console.log("RED (BAD)    Administrator wrongly reported as missing permissions"); failures.push("admin bit"); }
}

console.log("\n=== Stripe failure modes ===");
await expectRed("price is not $25", checkStripe, { priceAmount: 4900 }, "not 25.00");
await expectRed("price is recurring, not one-time", checkStripe, { priceType: "recurring" }, "not one-time");
await expectRed("price is archived", checkStripe, { priceActive: false }, "archived");
await expectRed("no endpoint registered for our URL", checkStripe,
  { endpointUrl: "https://example.com/other" }, "no endpoint with url");
await expectRed("endpoint disabled", checkStripe, { endpointStatus: "disabled" }, "endpoint enabled");
await expectRed("charge.refunded not subscribed", checkStripe,
  { endpointEvents: ["checkout.session.completed"] }, "refund, and keep access forever");
await expectRed("checkout.session.completed not subscribed", checkStripe,
  { endpointEvents: ["charge.refunded"] }, "nothing is ever fulfilled");
await expectRed("test key against a live endpoint", checkStripe, { endpointLivemode: true }, "mode");
await expectRed("old Railway endpoint still enabled", checkStripe, {
  extraEndpoints: [{
    url: "https://discord-access-bot-production-76d3.up.railway.app/stripe-webhook",
    status: "enabled", enabled_events: ["checkout.session.completed"], livemode: false,
  }],
}, "fulfilled twice");

console.log("\n=== Resend failure modes ===");
await expectRed("domain added but NOT verified", checkResend, { resendStatus: "pending" }, "added is not enough");
await expectRed("domain not in the account at all", checkResend, { resendDomain: "somewhere-else.com" }, "not in this resend account");

console.log("\n=== Deployment failure modes ===");
await expectRed("env vars never reached Cloudflare", checkDeployment, { checkoutStatus: 503 }, "push-env");
await expectRed("Functions bundle did not ship", checkDeployment, { checkoutStatus: 405 }, "functions bundle");
await expectRed("endpoint returns no checkout URL", checkDeployment,
  { checkoutStatus: 200, checkoutBody: { ok: false, error: "checkout failed" } }, "without a checkout url");
await expectRed("endpoint returns a non-Stripe URL", checkDeployment,
  { checkoutStatus: 200, checkoutBody: { ok: true, url: "https://evil.example.com/pay" } }, "unexpected url");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED: " + failures.join(", ")); process.exit(1); }
