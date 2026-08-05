// GET /claim?code=… — first leg of the Wolf Den access claim.
//
// The Stripe webhook mints a one-time code and emails a link here. This leg
// only validates the code and hands the visitor to Discord's consent screen;
// functions/claim/callback.js does the actual granting.
//
// Bindings expected on the Pages project:
//   MEMBERS           — KV. Holds claim:<code>, member:<email>, state:<state>.
//   DISCORD_CLIENT_ID — the OAuth app's client id.
//   SITE_ORIGIN       — builds redirect_uri. MUST match the redirect URI
//                       registered on the Discord app character for character,
//                       or Discord refuses the handover with its own error page.

// identify → we need the user's id to assign the role.
// guilds.join → lets the bot add them to the guild on their behalf.
const OAUTH_SCOPES = "identify guilds.join";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const code = String(url.searchParams.get("code") || "").trim();

    if (!code) {
      return page(
        "Missing access code",
        "That link is missing its access code. Use the link from your receipt email exactly as it was sent.",
        400
      );
    }

    if (!env.MEMBERS || !env.DISCORD_CLIENT_ID) {
      return page(
        "Not ready yet",
        "Access claiming is not switched on for this site yet. Nothing is wrong with your payment, and your link will keep working.",
        503
      );
    }

    const raw = await env.MEMBERS.get("claim:" + code);
    if (raw === null) {
      return page(
        "Unknown access code",
        "We do not recognise that code. Check the link in your receipt email, or just reply to that email and we will sort you out.",
        404
      );
    }

    let rec = null;
    try { rec = JSON.parse(raw); } catch { rec = null; }

    if (rec && rec.used) {
      return page(
        "Already claimed",
        "This code has already been used. If that was not you, reply to your receipt email and we will look into it.",
        409
      );
    }
    if (rec && rec.revoked) {
      return page(
        "Code no longer valid",
        "This code was cancelled, which normally means the payment was refunded. Reply to your receipt email if that looks wrong.",
        409
      );
    }

    // Single-use CSRF token tying this browser to this claim code. Discord hands
    // it back on the callback, and without it we would accept a callback nobody
    // here initiated. Ten minutes is plenty for a consent screen.
    const state = randomHex(16);
    await env.MEMBERS.put(
      "state:" + state,
      JSON.stringify({ code: code, ts: Date.now() }),
      { expirationTtl: 600 }
    );

    const origin = String(env.SITE_ORIGIN || url.origin).replace(/\/+$/, "");
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", origin + "/claim/callback");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", OAUTH_SCOPES);
    authorize.searchParams.set("state", state);

    return Response.redirect(authorize.toString(), 302);
  } catch (err) {
    console.log("claim start error", err && err.message);
    return page(
      "Something broke",
      "We could not start the handover to Discord. Try your link again in a minute.",
      500
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return page("Method not allowed", "Open this link in a browser.", 405);
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.prototype.map
    .call(b, function (x) { return x.toString(16).padStart(2, "0"); })
    .join("");
}

// Standalone HTML shell for the handful of dead ends this leg can hit.
// Colours are hardcoded rather than pulled from tokens.css: this is a Function
// response, so it cannot reference the site's stylesheet, and _headers' CSP has
// no 'self' in style-src anyway. Keep these values in step with tokens.css by
// eye if the palette ever moves.
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
