// GET /claim/callback?code=…&state=… — second leg of the Wolf Den access claim.
//
// Discord sends the buyer back here after the consent screen. This leg trades
// the OAuth code for a user token, reads who they are, puts them in the guild
// with the paid role, and burns the claim code.
//
// Bindings expected on the Pages project:
//   MEMBERS               — KV. claim:<code>, member:<email>, state:<state>.
//   DISCORD_CLIENT_ID     — OAuth app client id.
//   DISCORD_CLIENT_SECRET — OAuth app client secret.
//   DISCORD_BOT_TOKEN     — bot token. The bot must be IN the guild and hold
//                           BOTH permissions below.
//   DISCORD_GUILD_ID      — the Wolf Den guild.
//   DISCORD_PAID_ROLE_ID  — the role that opens the paid channels.
//   SITE_ORIGIN           — must rebuild the same redirect_uri used on leg one.
//
// Two Discord permissions are required and they are easy to get half right:
//   CREATE_INSTANT_INVITE — to add a member to the guild at all.
//   MANAGE_ROLES          — to attach `roles` while doing it.
// A bot with only MANAGE_ROLES fails for people who are not in the guild yet;
// a bot with only CREATE_INSTANT_INVITE adds them with no paid access.
// The bot's own role must also sit ABOVE the paid role in the server's role
// list, or Discord answers 403 no matter which permissions are ticked.

const DISCORD_API = "https://discord.com/api/v10";

const REQUIRED_ENV = [
  "MEMBERS",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_PAID_ROLE_ID",
];

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const oauthCode = String(url.searchParams.get("code") || "");
    const state = String(url.searchParams.get("state") || "");

    // The user pressed Cancel on Discord's consent screen.
    if (url.searchParams.get("error")) {
      return page(
        "Not authorised",
        "You cancelled the Discord step, so nothing changed. Your access link still works, open it again whenever you are ready.",
        400
      );
    }

    if (!oauthCode || !state) {
      return page(
        "Incomplete handover",
        "Discord sent you back without the details we need. Open your access link again to restart it.",
        400
      );
    }

    for (const key of REQUIRED_ENV) {
      if (!env[key]) {
        console.log("claim callback missing config", key);
        return page(
          "Not ready yet",
          "Access claiming is not switched on for this site yet. Nothing is wrong with your payment.",
          503
        );
      }
    }

    // State is single use. Read it, delete it immediately, and only then do any
    // work, so a replayed callback cannot spend the same code twice.
    const stateRaw = await env.MEMBERS.get("state:" + state);
    if (stateRaw === null) {
      return page(
        "Handover expired",
        "That handover expired or was already used. Open your access link again to restart it.",
        400
      );
    }
    await env.MEMBERS.delete("state:" + state);

    let claimCode = null;
    try { claimCode = JSON.parse(stateRaw).code; } catch { claimCode = null; }
    if (!claimCode) {
      return page("Handover expired", "Open your access link again to restart it.", 400);
    }

    const claimRaw = await env.MEMBERS.get("claim:" + claimCode);
    if (claimRaw === null) {
      return page(
        "Unknown access code",
        "We do not recognise that code. Reply to your receipt email and we will sort you out.",
        404
      );
    }
    const claim = JSON.parse(claimRaw);
    if (claim.used) {
      return page(
        "Already claimed",
        "This code has already been used. If that was not you, reply to your receipt email.",
        409
      );
    }
    if (claim.revoked) {
      return page(
        "Code no longer valid",
        "This code was cancelled, which normally means the payment was refunded.",
        409
      );
    }

    const origin = String(env.SITE_ORIGIN || url.origin).replace(/\/+$/, "");

    // ---- 1. trade the one-time OAuth code for a user access token ----
    const tokenForm = new URLSearchParams();
    tokenForm.set("client_id", env.DISCORD_CLIENT_ID);
    tokenForm.set("client_secret", env.DISCORD_CLIENT_SECRET);
    tokenForm.set("grant_type", "authorization_code");
    tokenForm.set("code", oauthCode);
    tokenForm.set("redirect_uri", origin + "/claim/callback");

    const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    });
    if (!tokenRes.ok) {
      console.log("discord token exchange failed", tokenRes.status, await safeText(tokenRes));
      return page(
        "Discord turned us away",
        "We could not complete the handover with Discord. Open your access link again, and reply to your receipt email if it keeps failing.",
        502
      );
    }
    const accessToken = (await tokenRes.json()).access_token;
    if (!accessToken) {
      return page("Discord turned us away", "Open your access link again to retry.", 502);
    }

    // ---- 2. who are they ----
    const meRes = await fetch(DISCORD_API + "/users/@me", {
      headers: { authorization: "Bearer " + accessToken },
    });
    if (!meRes.ok) {
      console.log("discord users/@me failed", meRes.status, await safeText(meRes));
      return page("Discord turned us away", "Open your access link again to retry.", 502);
    }
    const me = await meRes.json();
    const userId = me && me.id;
    if (!userId) {
      return page("Discord turned us away", "Open your access link again to retry.", 502);
    }

    // ---- 3. put them in the guild with the paid role ----
    // 201 = we added them and `roles` was applied.
    // 204 = THEY WERE ALREADY A MEMBER, and Discord silently ignored `roles`.
    // The funnel is explicitly join-free-then-upgrade, so 204 is the COMMON
    // case, not the edge case. Without the follow-up call below, the typical
    // buyer would pay and receive nothing.
    const addRes = await fetch(
      DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + userId,
      {
        method: "PUT",
        headers: {
          authorization: "Bot " + env.DISCORD_BOT_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          access_token: accessToken,
          roles: [env.DISCORD_PAID_ROLE_ID],
        }),
      }
    );

    if (addRes.status === 204) {
      const roleRes = await fetch(
        DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + userId +
          "/roles/" + env.DISCORD_PAID_ROLE_ID,
        {
          method: "PUT",
          headers: {
            authorization: "Bot " + env.DISCORD_BOT_TOKEN,
            "content-length": "0",
          },
        }
      );
      if (!roleRes.ok) {
        // 403 here is almost always the role hierarchy: the bot's own role is
        // not above the paid role. Ticking MANAGE_ROLES does not fix that.
        console.log("discord add-role failed", roleRes.status, await safeText(roleRes));
        return page(
          "Could not grant the role",
          "You are in the server, but we could not attach your paid role. Reply to your receipt email and we will fix it by hand, your code is still valid.",
          502
        );
      }
    } else if (addRes.status !== 201) {
      console.log("discord add-member failed", addRes.status, await safeText(addRes));
      return page(
        "Could not add you to the server",
        "Discord would not let us add you just now. Reply to your receipt email and we will fix it by hand, your code is still valid.",
        502
      );
    }

    // ---- 4. burn the code, and record who claimed it ----
    // discord_user_id is what makes refund revocation possible later; without it
    // a refunded buyer keeps the role forever.
    claim.used = true;
    claim.discord_user_id = userId;
    claim.claimed_ts = Date.now();
    await env.MEMBERS.put("claim:" + claimCode, JSON.stringify(claim));

    if (claim.email) {
      const memberRaw = await env.MEMBERS.get("member:" + claim.email);
      if (memberRaw !== null) {
        const member = JSON.parse(memberRaw);
        member.claimed = true;
        member.discord_user_id = userId;
        member.claimed_ts = claim.claimed_ts;
        await env.MEMBERS.put("member:" + claim.email, JSON.stringify(member));
      }
    }

    // Drop them straight into the server rather than onto another web page.
    return Response.redirect("https://discord.com/channels/" + env.DISCORD_GUILD_ID, 302);
  } catch (err) {
    console.log("claim callback error", err && err.message);
    return page(
      "Something broke",
      "We could not finish the handover. Reply to your receipt email and we will sort it out by hand.",
      500
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return page("Method not allowed", "Open this link in a browser.", 405);
}

// Discord's error bodies are useful in logs and must never reach the visitor.
async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return "<unreadable>"; }
}

// Kept in step with functions/claim/index.js on purpose: these two files are
// deliberately standalone so the Functions bundle stays a flat set of leaves
// with no shared imports, per the no-build-step constraint in CLAUDE.md.
function page(title, body, status) {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(title) + " &middot; Chainlock</title><style>" +
    ":root{color-scheme:dark}" +
    "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;" +
    "background:#0a0a0b;color:#e9e9ea;" +
    "font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
    ".card{max-width:38rem;border:1px solid #26262a;border-radius:12px;" +
    "background:#111113;padding:32px}" +
    "h1{margin:0 0 12px;font-size:1.15rem;letter-spacing:-0.01em}" +
    "p{margin:0 0 20px;color:#a1a1a6}p:last-child{margin-bottom:0}" +
    "a{color:#e9e9ea}" +
    '</style></head><body><div class="card">' +
    "<h1>" + esc(title) + "</h1><p>" + esc(body) + "</p>" +
    '<p><a href="/">Back to chainlock.gg</a></p>' +
    "</div></body></html>";
  return new Response(html, {
    status: status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
