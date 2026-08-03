#!/usr/bin/env node
/**
 * One-time helper to mint a Google OAuth **refresh token** for the Outreach group-meeting feature
 * (AQ\Meet) — works with a normal personal Google account, NO Workspace required.
 *
 * Prerequisites (in Google Cloud Console, project ashraacademy-1690577942187 is fine):
 *   1. APIs & Services → Library → enable "Google Calendar API".
 *   2. OAuth consent screen → User type "External" → fill the basics → **Publish app**
 *      (status "In production"; if left in "Testing" the refresh token expires after 7 days).
 *      Add the scope  https://www.googleapis.com/auth/calendar.events
 *   3. Credentials → Create credentials → OAuth client ID → Application type **Desktop app**.
 *      Copy the Client ID + Client secret.
 *
 * Then run (the account you sign in with becomes the meetings' host):
 *   node google_oauth.mjs <CLIENT_ID> <CLIENT_SECRET>
 * It opens a consent URL, you approve (click through the "unverified app" notice — it's your own
 * app), and it prints the three values to put in wp-config.php:
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 */
import http from "node:http";
import { exec } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node google_oauth.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const PORT = 4747;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400).end("No code"); return; }

  try {
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: REDIRECT, grant_type: "authorization_code",
      }),
    }).then((r) => r.json());

    if (!tok.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/plain" })
        .end("No refresh_token returned. Revoke the app's access at myaccount.google.com/permissions and run again.");
      console.error("\n✖ No refresh_token in response:", tok);
      server.close(); return;
    }

    res.writeHead(200, { "Content-Type": "text/html" })
      .end("<h2>✓ Done — you can close this tab and return to the terminal.</h2>");
    console.log("\n✓ Add these to wp-config.php (gitignored — never the DB):\n");
    console.log(`define( 'GOOGLE_OAUTH_CLIENT_ID', '${clientId}' );`);
    console.log(`define( 'GOOGLE_OAUTH_CLIENT_SECRET', '${clientSecret}' );`);
    console.log(`define( 'GOOGLE_OAUTH_REFRESH_TOKEN', '${tok.refresh_token}' );\n`);
  } catch (e) {
    res.writeHead(500).end("Token exchange failed: " + e.message);
    console.error(e);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\nOpen this URL, sign in with the account that should HOST the meetings, and approve:\n");
  console.log(authUrl + "\n");
  exec(`open "${authUrl}" || xdg-open "${authUrl}"`, () => {});
});
