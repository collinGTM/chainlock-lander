// Preflight: does the live configuration actually work?
//
//   node tests/preflight.mjs
//
// Read-only against every API. Reads credentials from site/.dev.vars or the
// environment, never from argv, so nothing lands in shell history. Prints
// variable names and API verdicts, never secret values.
//
// Exits non-zero if anything fails, so it can gate a deploy.
//
// The checks are exported so tests/preflight.test.mjs can drive them against
// mocked responses and prove each one reports red when the setup is wrong. A
// preflight that only ever passes is worse than none, because it would license
// taking real money.

import { readFileSync, existsSync } from "node:fs";

const DISCORD_API = "https://discord.com/api/v10";
const PERM_CREATE_INSTANT_INVITE = 1n;
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_ROLES = 1n << 28n;
const EXPECTED_AMOUNT = 2500; // $25.00 in cents

export const PASS = "pass";
export const FAIL = "fail";
export const WARN = "warn";

const ok = (label, detail) => ({ level: PASS, label, detail });
const bad = (label, detail, fix) => ({ level: FAIL, label, detail, fix });
const meh = (label, detail, fix) => ({ level: WARN, label, detail, fix });

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
export async function checkDiscord(env, fetchImpl = fetch) {
  const out = [];
  const auth = { authorization: "Bot " + env.DISCORD_BOT_TOKEN };
  const get = (p) => fetchImpl(DISCORD_API + p, { headers: auth });

  let botId = null;
  try {
    const r = await get("/users/@me");
    if (!r.ok) {
      out.push(bad("Discord bot token", `Discord rejected it (${r.status})`,
        "Reset the token at discord.com/developers → your app → Bot → Reset Token, and make sure you pasted the token only, without 'Bot ' in front."));
      return out; // nothing else is checkable without a valid token
    }
    const me = await r.json();
    botId = me.id;
    out.push(ok("Discord bot token", `authenticated as ${me.username}`));
  } catch (e) {
    out.push(bad("Discord bot token", "could not reach Discord: " + e.message, "Check your network."));
    return out;
  }

  const guildRes = await get("/guilds/" + env.DISCORD_GUILD_ID);
  if (!guildRes.ok) {
    out.push(bad("Bot is in the server", `Discord returned ${guildRes.status} for guild ${env.DISCORD_GUILD_ID}`,
      guildRes.status === 404
        ? "That id is not a server the bot can see. You may have copied a CHANNEL id: right-click the server ICON, not a channel."
        : "Invite the bot using the URL in SETUP.md step 5."));
    return out;
  }
  const guild = await guildRes.json();
  out.push(ok("Bot is in the server", guild.name));

  const rolesRes = await get("/guilds/" + env.DISCORD_GUILD_ID + "/roles");
  if (!rolesRes.ok) {
    out.push(bad("Read server roles", `Discord returned ${rolesRes.status}`, "Check the bot's permissions."));
    return out;
  }
  const roles = await rolesRes.json();

  const paidRole = roles.find((r) => r.id === env.DISCORD_PAID_ROLE_ID);
  if (!paidRole) {
    out.push(bad("Paid role exists", `no role with id ${env.DISCORD_PAID_ROLE_ID} in ${guild.name}`,
      "Server Settings → Roles → right-click the paid role → Copy Role ID."));
    return out;
  }
  out.push(ok("Paid role exists", `"${paidRole.name}" at position ${paidRole.position}`));

  const memberRes = await get("/guilds/" + env.DISCORD_GUILD_ID + "/members/" + botId);
  if (!memberRes.ok) {
    out.push(bad("Read the bot's own roles", `Discord returned ${memberRes.status}`, "Re-invite the bot."));
    return out;
  }
  const member = await memberRes.json();
  const botRoles = roles.filter((r) => (member.roles || []).includes(r.id));

  // --- the silent one: role hierarchy ---
  const botTop = botRoles.reduce((m, r) => (r.position > m.position ? r : m), { position: -1, name: "(none)" });
  if (botTop.position > paidRole.position) {
    out.push(ok("Bot's role outranks the paid role", `"${botTop.name}" (${botTop.position}) > "${paidRole.name}" (${paidRole.position})`));
  } else {
    out.push(bad("Bot's role outranks the paid role",
      `bot's highest is "${botTop.name}" at ${botTop.position}, paid role "${paidRole.name}" is at ${paidRole.position}`,
      "Server Settings → Roles → DRAG the bot's role ABOVE the paid role. Discord refuses to grant a role ranked above the bot's own, and returns a bare 403 with every permission correctly ticked. This is the single most common way this setup silently fails."));
  }

  // --- permission bits ---
  // @everyone is the role whose id equals the guild id, and it applies too.
  const everyone = roles.find((r) => r.id === env.DISCORD_GUILD_ID);
  const effective = [...botRoles, ...(everyone ? [everyone] : [])]
    .reduce((acc, r) => acc | BigInt(r.permissions || "0"), 0n);

  if (effective & PERM_ADMINISTRATOR) {
    out.push(ok("Bot permissions", "Administrator, which covers both requirements"));
  } else {
    const hasInvite = (effective & PERM_CREATE_INSTANT_INVITE) !== 0n;
    const hasRoles = (effective & PERM_MANAGE_ROLES) !== 0n;
    if (hasInvite && hasRoles) {
      out.push(ok("Bot permissions", "Create Instant Invite + Manage Roles"));
    } else {
      const missing = [!hasInvite && "Create Instant Invite", !hasRoles && "Manage Roles"].filter(Boolean);
      out.push(bad("Bot permissions", "missing " + missing.join(" and "),
        !hasInvite && !hasRoles
          ? "Re-invite with permissions=268435457 (SETUP.md step 5)."
          : !hasInvite
          ? "Without Create Instant Invite, anyone NOT already in the server cannot be added at all. Re-invite with permissions=268435457."
          : "Without Manage Roles, buyers get added but receive NO paid access. Re-invite with permissions=268435457."));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
export async function checkStripe(env, fetchImpl = fetch) {
  const out = [];
  const get = (p) =>
    fetchImpl("https://api.stripe.com" + p, {
      headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY },
    });

  const keyIsLive = String(env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");
  out.push(meh("Stripe mode", keyIsLive ? "LIVE, real cards will be charged" : "TEST, nothing real can be charged",
    keyIsLive
      ? "Make sure vibrant-legacy is disabled before the first live sale."
      : "Correct for the first run. Swap to the live key when you go live."));

  const priceRes = await get("/v1/prices/" + env.STRIPE_PRICE_ID);
  if (!priceRes.ok) {
    out.push(bad("Price exists", `Stripe returned ${priceRes.status} for ${env.STRIPE_PRICE_ID}`,
      "Copy the API ID from the product's Pricing section. It starts price_, not prod_. Also check you are not using a test price with a live key."));
  } else {
    const price = await priceRes.json();
    const problems = [];
    if (!price.active) problems.push("it is archived");
    if (price.type !== "one_time") problems.push(`it is ${price.type}, not one-time`);
    if (price.unit_amount !== EXPECTED_AMOUNT) problems.push(`it is ${(price.unit_amount / 100).toFixed(2)}, not 25.00`);
    if (problems.length) {
      out.push(bad("Price is $25 one-time", problems.join("; "),
        "The page advertises $25 one time. Either fix the price in Stripe or change the copy in site/index.html, but they must agree."));
    } else {
      out.push(ok("Price is $25 one-time", `${(price.unit_amount / 100).toFixed(2)} ${String(price.currency).toUpperCase()}`));
    }
  }

  const epRes = await get("/v1/webhook_endpoints?limit=100");
  if (!epRes.ok) {
    out.push(bad("Read webhook endpoints", `Stripe returned ${epRes.status}`,
      "The key may lack permission to list webhook endpoints."));
    return out;
  }
  const endpoints = (await epRes.json()).data || [];
  const wanted = String(env.SITE_ORIGIN).replace(/\/+$/, "") + "/api/stripe-webhook";
  const mine = endpoints.find((e) => e.url === wanted);

  if (!mine) {
    out.push(bad("Webhook endpoint registered", `no endpoint with URL ${wanted}`,
      `Developers → Webhooks → Add endpoint → ${wanted}, subscribed to checkout.session.completed and charge.refunded. Note endpoints are per-mode: one made in test mode does not exist in live mode.`));
  } else {
    if (mine.status !== "enabled") {
      out.push(bad("Webhook endpoint enabled", `status is "${mine.status}"`, "Enable it in the Stripe dashboard."));
    } else {
      out.push(ok("Webhook endpoint registered", wanted));
    }
    const events = mine.enabled_events || [];
    const needed = ["checkout.session.completed", "charge.refunded"];
    const missing = needed.filter((e) => !events.includes(e) && !events.includes("*"));
    if (missing.length) {
      out.push(bad("Webhook events", "missing " + missing.join(", "),
        missing.includes("charge.refunded")
          ? "Without charge.refunded someone can buy, claim the role, refund, and keep access forever."
          : "Without checkout.session.completed nothing is ever fulfilled."));
    } else {
      out.push(ok("Webhook events", needed.join(" + ")));
    }
    if (mine.livemode !== keyIsLive) {
      out.push(bad("Key mode matches endpoint mode",
        `key is ${keyIsLive ? "live" : "test"} but the endpoint is ${mine.livemode ? "live" : "test"}`,
        "Stripe keeps test and live endpoints separate, each with its own signing secret. Create the endpoint in the same mode as the key you are using."));
    }
  }

  // The old Railway bot. Two endpoints on the same event means every purchase
  // gets handled twice by two different systems.
  const legacy = endpoints.filter(
    (e) => e.url !== wanted &&
      e.status === "enabled" &&
      (e.enabled_events || []).some((x) => x === "checkout.session.completed" || x === "*")
  );
  if (legacy.length) {
    out.push(bad("No other endpoint competing for the same event",
      `${legacy.length} other enabled endpoint(s) also receive checkout.session.completed: ${legacy.map((e) => e.url).join(", ")}`,
      "Disable the old Railway endpoint (vibrant-legacy) in Stripe before the first real sale, or every purchase is fulfilled twice."));
  } else {
    out.push(ok("No other endpoint competing for the same event", "this is the only one"));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------
export async function checkResend(env, fetchImpl = fetch) {
  const out = [];
  const res = await fetchImpl("https://api.resend.com/domains", {
    headers: { authorization: "Bearer " + env.RESEND_API_KEY },
  });
  if (!res.ok) {
    out.push(bad("Resend API key", `Resend returned ${res.status}`, "Create a new key at resend.com → API Keys."));
    return out;
  }
  out.push(ok("Resend API key", "accepted"));

  const body = await res.json();
  const domains = body.data || body || [];

  // "Chainlock <access@chainlock.gg>" or "access@chainlock.gg"
  const from = String(env.MEMBER_FROM_EMAIL || "");
  const addr = (from.match(/<([^>]+)>/) || [null, from])[1] || from;
  const fromDomain = addr.split("@")[1];

  if (!fromDomain) {
    out.push(bad("Sender address", `could not read a domain out of "${from}"`,
      'Use access@chainlock.gg or "Chainlock <access@chainlock.gg>".'));
    return out;
  }

  const match = domains.find((d) => d.name === fromDomain);
  if (!match) {
    out.push(bad("Sending domain added", `${fromDomain} is not in this Resend account`,
      `resend.com → Domains → Add Domain → ${fromDomain}.`));
  } else if (match.status !== "verified") {
    out.push(bad("Sending domain verified", `${fromDomain} status is "${match.status}"`,
      "Added is not enough. Finish the SPF and DKIM records and wait for Verified, or buyers never receive their access link and nothing looks broken until then."));
  } else {
    out.push(ok("Sending domain verified", fromDomain));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cloudflare, by integration
//
// Pages env vars and KV bindings cannot be read from outside, so the only real
// proof they landed is asking the deployed endpoint to do its job.
// ---------------------------------------------------------------------------
export async function checkDeployment(env, fetchImpl = fetch) {
  const out = [];
  const origin = String(env.SITE_ORIGIN).replace(/\/+$/, "");
  let res;
  try {
    res = await fetchImpl(origin + "/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (e) {
    out.push(bad("Deployed /api/checkout", "could not reach it: " + e.message, `Is ${origin} deployed?`));
    return out;
  }

  if (res.status === 503) {
    out.push(bad("Deployed /api/checkout", "returns 503, so Stripe is not configured on the deployed site",
      "The env vars have not reached Cloudflare. Run ./setup/push-env.sh, then redeploy."));
    return out;
  }
  if (res.status === 405) {
    out.push(bad("Deployed /api/checkout", "returns 405 to a POST",
      "The Functions bundle did not ship. Redeploy from inside site/ and confirm the output contains 'Uploading Functions bundle'."));
    return out;
  }

  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!body || !body.ok || !body.url) {
    out.push(bad("Deployed /api/checkout", `returned ${res.status} without a checkout URL`,
      "Check the Pages deployment logs. The Stripe key or price id may be wrong in the deployed environment."));
    return out;
  }
  if (!/^https:\/\/checkout\.stripe\.com\//.test(body.url)) {
    out.push(bad("Deployed /api/checkout", `returned an unexpected URL host`,
      "Expected a checkout.stripe.com URL."));
    return out;
  }
  out.push(ok("Deployed /api/checkout", "created a real Stripe Checkout Session"));
  return out;
}

export async function runAll(env, fetchImpl = fetch) {
  const groups = [
    ["Discord", await checkDiscord(env, fetchImpl)],
    ["Stripe", await checkStripe(env, fetchImpl)],
    ["Resend", await checkResend(env, fetchImpl)],
    ["Cloudflare", await checkDeployment(env, fetchImpl)],
  ];
  return groups;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function loadEnv(file) {
  const out = { ...process.env };
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const k = t.slice(0, t.indexOf("=")).trim();
      let v = t.slice(t.indexOf("=") + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      // The file is the source of truth for a local run; process.env only fills gaps.
      if (k) out[k] = v;
    }
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const envFile = new URL("../site/.dev.vars", import.meta.url).pathname;
  const env = loadEnv(envFile);

  const REQUIRED = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "RESEND_API_KEY", "MEMBER_FROM_EMAIL",
    "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_PAID_ROLE_ID", "SITE_ORIGIN"];
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    console.log("\x1b[31mCannot run: these are not set in site/.dev.vars\x1b[0m\n");
    for (const m of missing) console.log("    " + m);
    console.log("\nStart from site/.dev.vars.example and follow SETUP.md.");
    process.exit(1);
  }

  const groups = await runAll(env);
  let fails = 0;
  for (const [name, results] of groups) {
    console.log(`\n\x1b[1m${name}\x1b[0m`);
    for (const r of results) {
      if (r.level === PASS) console.log(`  \x1b[32m✓\x1b[0m ${r.label}  \x1b[2m${r.detail}\x1b[0m`);
      else if (r.level === WARN) console.log(`  \x1b[33m!\x1b[0m ${r.label}  \x1b[2m${r.detail}\x1b[0m`);
      else {
        fails++;
        console.log(`  \x1b[31m✗ ${r.label}\x1b[0m  ${r.detail}`);
        if (r.fix) console.log(`      \x1b[2m→ ${r.fix}\x1b[0m`);
      }
    }
  }
  console.log();
  if (fails) {
    console.log(`\x1b[31m${fails} problem(s). Do not take real money until these are clear.\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32mAll checks passed. Do a test purchase next (SETUP.md, Check it worked).\x1b[0m");
}
