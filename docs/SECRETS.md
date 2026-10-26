# Secrets and settings

<!-- GENERATED from wp-content/plugins/aquest/src/SecretRegistry.php by tools/secrets-doc.php --write. Do not edit by hand; preflight fails when this file is stale. -->

Every secret and setting that production artaquest.com reads, grouped by purpose. The same definitions drive the **wp-admin → AQ Security** page (descriptions, groups, rotation clock) and the `ops.secrets` health check.

## How it works

- **Define** — `src/SecretRegistry.php`: name, group, tier, purpose, who reads it, where to get or rotate it, what breaks without it, and its old names.
- **Resolve** — `Secrets::get('NAME')` reads the encrypted vault first, then the environment, then a `wp-config.php` constant. Asking for an old name, or storing under one, still works.
- **Store** — `src/Vault.php`: the encrypted vault file (`wp-content/aq-vault.php`, libsodium, keyed from `AUTH_KEY`/`AUTH_SALT`) and the AQ Security page. Values are write-only: the page shows set/unset, source, age and the last 4 characters, never a value. The database is public, so a secret never goes in it.
- **Watch** — `src/Watchdog.php`: rotation due, compromised flags, vault-file changes, the leak sweep of public options, honeypot traps, and the audit log.

**Adding a key:** add it to `SecretRegistry::KEYS`, read it with `Secrets::get`, run `tools/secrets-doc.php --write`. Only list a name that production code reads — a local script reads its own environment variable. No `AQ_` prefix.

## Rotation policy

| Tier | Clock | For |
|---|---|---|
| critical | 90 days | moves money, sends mail as us, or writes our storage/Cloudflare account |
| standard | 180 days | one bot, one route, or one integration |
| low | 365 days | a narrow token that only publishes our own public work or reads public data |
| none | — | not a credential: identifiers, addresses, endpoints, publishable keys, flags |

Rotate on the clock, and immediately when a value may have been exposed (use **Flag leaked** on the page first). To rotate: create the new value at the issuer, paste it into **Rotate** on AQ Security, check the feature works, then revoke the old value at the issuer.

**Need:** `required` = the health check fails without it; `optional` = the feature is off without it; a NAME = either this or that one is enough.

## Summary

| Name | Group | Tier | Rotation | Need | Old name |
|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Payments | critical | 90 d | required | — |
| `STRIPE_WEBHOOK_SECRET` | Payments | critical | 90 d | required | — |
| `STRIPE_PUBLISHABLE_KEY` | Payments | none | — | required | — |
| `MAIL_ACS_CONNECTION` | Email | critical | 90 d | or `MAIL_SMTP_PASSWORD` | `AQ_ACS_EMAIL_CONNECTION` |
| `MAIL_ACS_SENDER` | Email | none | — | optional | `AQ_ACS_EMAIL_SENDER` |
| `MAIL_SMTP_PASSWORD` | Email | critical | 90 d | or `MAIL_ACS_CONNECTION` | `SMTP_PASS` |
| `MAIL_SMTP_HOST` | Email | none | — | optional | `SMTP_HOST` |
| `MAIL_SMTP_PORT` | Email | none | — | optional | `SMTP_PORT` |
| `MAIL_SMTP_USER` | Email | none | — | optional | `SMTP_USER` |
| `MAIL_TITAN_PASSWORD` | Email | critical | 90 d | optional | `TITAN_PASSWORD` |
| `MAIL_ALERTS_TO` | Email | none | — | optional | `OPERATOR_EMAIL` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | none | — | optional | `AQ_R2_ACCOUNT` |
| `R2_BUCKET` | Cloudflare | none | — | optional | `AQ_R2_BUCKET` |
| `R2_ACCESS_KEY_ID` | Cloudflare | critical | 90 d | optional | `AQ_R2_KEY` |
| `R2_SECRET_ACCESS_KEY` | Cloudflare | critical | 90 d | optional | `AQ_R2_SECRET` |
| `MEDIA_CDN_URL` | Cloudflare | none | — | optional | `AQ_MEDIA_CDN` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | critical | 90 d | optional | `AQ_CF_API_TOKEN` |
| `CALLS_TURN_KEY_ID` | Calls | none | — | optional | `AQ_CF_TURN_KEY_ID` |
| `CALLS_TURN_KEY_TOKEN` | Calls | standard | 180 d | optional | `AQ_CF_TURN_KEY_TOKEN` |
| `CALLS_TURN_URLS` | Calls | none | — | optional | `AQ_TURN_URLS` |
| `CALLS_TURN_USER` | Calls | none | — | optional | `AQ_TURN_USER` |
| `CALLS_TURN_PASSWORD` | Calls | standard | 180 d | optional | `AQ_TURN_PASS` |
| `GOOGLE_SIGNIN_CLIENT_ID` | Google | none | — | required | `GOOGLE_OAUTH_CLIENT_ID` |
| `YOUTUBE_SERVICE_ACCOUNT_JSON` | Google | standard | 180 d | or `YOUTUBE_API_KEY` | `YOUTUBE_SA_JSON` |
| `YOUTUBE_API_KEY` | Google | low | 365 d | or `YOUTUBE_SERVICE_ACCOUNT_JSON` | — |
| `KAGGLE_TOKEN` | Integrations | low | 365 d | optional | — |
| `KAGGLE_API_KEY` | Integrations | standard | 180 d | optional | `KAGGLE_KEY` |
| `KAGGLE_USERNAME` | Integrations | none | — | optional | — |
| `GITHUB_GIST_TOKEN` | Integrations | low | 365 d | optional | — |
| `ZENODO_TOKEN` | Integrations | low | 365 d | optional | — |
| `X_BEARER_TOKEN` | Feeds | low | 365 d | optional | — |
| `REDDIT_CLIENT_ID` | Feeds | none | — | optional | — |
| `REDDIT_CLIENT_SECRET` | Feeds | low | 365 d | optional | — |
| `IG_ACCESS_TOKEN` | Feeds | low | 365 d | optional | — |
| `IG_USER_ID` | Feeds | none | — | optional | — |
| `LINKEDIN_ACCESS_TOKEN` | Feeds | low | 365 d | optional | — |
| `BOT_ARTA_TOKEN` | Bot tokens | standard | 180 d | optional | `AQ_ARTA_REPLY_TOKEN` |
| `BOT_ARTAMAIL_TOKEN` | Bot tokens | standard | 180 d | optional | `AQ_ARTAMAIL_TOKEN` |
| `BOT_ARTASEARCH_TOKEN` | Bot tokens | standard | 180 d | optional | `AQ_ALUMNI_INGEST_TOKEN` |
| `BOT_WORKER_TOKEN` | Bot tokens | standard | 180 d | optional | `AQ_WORKER_TOKEN` |
| `ARTA_RELAY_SECRET` | Arta relay | standard | 180 d | optional | `AQ_TURN_SECRET` |
| `ARTA_RELAY_URL` | Arta relay | none | — | optional | `AQ_TURN_URL` |
| `ARTA_TOOLS_URL` | Arta relay | none | — | optional | `AQ_TURN_URL_TOOLS` |
| `ARTA_TOOLS_URL_LOW` | Arta relay | none | — | optional | — |
| `ARTA_TOOLS_URL_MEDIUM` | Arta relay | none | — | optional | — |
| `ARTA_TOOLS_URL_HIGH` | Arta relay | none | — | optional | — |
| `ARTA_TOOLS_URL_XHIGH` | Arta relay | none | — | optional | — |
| `ARTA_TOOLS_URL_MAX` | Arta relay | none | — | optional | — |
| `ARTA_TOOLS_URL_WORKFLOW` | Arta relay | none | — | optional | — |
| `ARTA_BROKER_URL` | Arta relay | none | — | optional | `AQ_BROKER_URL` |
| `ARTA_SHELL_URL` | Arta relay | none | — | optional | `AQ_SHELL_URL` |
| `TASK_SYNC_KEY` | Encryption | none | — | optional | `AQ_TASK_SYNC_KEY` |
| `FLAG_CASHOUT_FROZEN` | Flags | none | — | optional | `AQ_CASHOUT_FROZEN` |
| `FLAG_ALLOW_PASSWORD_LOGIN` | Flags | none | — | optional | `AQ_ALLOW_PASSWORD_LOGIN` |

## Payments

Stripe — coin purchases, donations, cash-outs.

### `STRIPE_SECRET_KEY`

- **Purpose:** Stripe live secret key (sk_live_…) — server-side calls for coin purchases, donations and cash-outs.
- **Used by:** Stripe.php, Economy.php, Extra.php · checkout + cash-out routes
- **Get / rotate:** dashboard.stripe.com → Developers → API keys → Roll secret key (or a restricted key with Checkout Sessions, PaymentIntents, Payouts/Transfers write).
- **Rotation:** every 90 days (critical)
- **Need:** required
- **If missing:** Paid checkout, donations and cash-outs are off (Stripe::enabled() is false).

### `STRIPE_WEBHOOK_SECRET`

- **Purpose:** Stripe webhook signing secret (whsec_…) — proves a payment event really came from Stripe.
- **Used by:** Stripe.php, Extra::stripe_webhook · POST /aq/v1/stripe/webhook
- **Get / rotate:** dashboard.stripe.com → Developers → Webhooks → the artaquest.com/wp-json/aq/v1/stripe/webhook endpoint → Roll secret.
- **Rotation:** every 90 days (critical)
- **Need:** required
- **If missing:** Payment events are rejected, so paid coins are not credited.

### `STRIPE_PUBLISHABLE_KEY`

- **Purpose:** Stripe publishable key (pk_live_…) — public by design, sent to browsers. Replace it when the secret key is rolled.
- **Used by:** Stripe.php, Extra.php · checkout page
- **Get / rotate:** dashboard.stripe.com → Developers → API keys.
- **Rotation:** no rotation
- **Need:** required
- **If missing:** The browser cannot open Stripe checkout.

## Email

Platform mail goes out through Azure (ACS); SMTP is the fallback. Either one is enough.

### `MAIL_ACS_CONNECTION`

- **Purpose:** Azure Communication Services connection string (endpoint=…;accesskey=…) — main sender for all platform email.
- **Used by:** Mailer.php · every outgoing email (sign-in codes, alerts, notices)
- **Get / rotate:** portal.azure.com → the Communication Services resource → Settings → Keys → Regenerate the secondary key, switch to it, then regenerate the primary.
- **Rotation:** every 90 days (critical)
- **Need:** this or `MAIL_SMTP_PASSWORD`
- **If missing:** Mail falls back to SMTP; with SMTP unset too, sign-in codes and alerts are not delivered.
- **Old name (still works):** `AQ_ACS_EMAIL_CONNECTION`

### `MAIL_ACS_SENDER`

- **Purpose:** Verified ACS sender address, e.g. DoNotReply@mail.artaquest.org.
- **Used by:** Mailer.php
- **Get / rotate:** portal.azure.com → Email Communication Service → the mail.artaquest.org domain → MailFrom addresses.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** The default DoNotReply@ address is used.
- **Old name (still works):** `AQ_ACS_EMAIL_SENDER`

### `MAIL_SMTP_PASSWORD`

- **Purpose:** SMTP password (app password) for the support@ mailbox — the fallback sender when ACS refuses.
- **Used by:** Mailer.php · every outgoing email when ACS is unset or fails
- **Get / rotate:** The mailbox provider (default Google: myaccount.google.com → Security → App passwords). Revoke the old app password after.
- **Rotation:** every 90 days (critical)
- **Need:** this or `MAIL_ACS_CONNECTION`
- **If missing:** No fallback when ACS fails.
- **Old name (still works):** `SMTP_PASS`

### `MAIL_SMTP_HOST`

- **Purpose:** SMTP host. Default smtp.gmail.com.
- **Used by:** Mailer.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Default is used.
- **Old name (still works):** `SMTP_HOST`

### `MAIL_SMTP_PORT`

- **Purpose:** SMTP port. Default 587 (STARTTLS); 465 = SSL.
- **Used by:** Mailer.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Default is used.
- **Old name (still works):** `SMTP_PORT`

### `MAIL_SMTP_USER`

- **Purpose:** SMTP username. Default support@artaquest.org.
- **Used by:** Mailer.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Default is used.
- **Old name (still works):** `SMTP_USER`

### `MAIL_TITAN_PASSWORD`

- **Purpose:** Titan mailbox password — handed ONLY to the ArtaMail bot, which reads and sends the Titan mailboxes.
- **Used by:** Vault::rest_titan · GET /aq/v1/secret/titan · ArtaMail
- **Get / rotate:** Titan admin panel (control.titan.email) → the mailbox → Reset password. ArtaMail picks the new one up on its next call.
- **Rotation:** every 90 days (critical)
- **Need:** optional
- **If missing:** ArtaMail cannot log in to Titan (the route answers 404).
- **Old name (still works):** `TITAN_PASSWORD`

### `MAIL_ALERTS_TO`

- **Purpose:** Where security and ops alerts are emailed.
- **Used by:** Mailer.php, Watchdog.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Alerts go to the site admin email.
- **Old name (still works):** `OPERATOR_EMAIL`

## Cloudflare

Media storage on R2 (bucket artaquest-media) and the account API token. All four storage values switch uploads to R2; with any one missing, files stay on this server.

### `CLOUDFLARE_ACCOUNT_ID`

- **Purpose:** Cloudflare account ID (32 hex) that owns the R2 bucket.
- **Used by:** Media.php · every upload and media URL
- **Get / rotate:** dash.cloudflare.com → any page → Account ID (right column).
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Uploads stay on this server.
- **Old name (still works):** `AQ_R2_ACCOUNT`

### `R2_BUCKET`

- **Purpose:** R2 bucket for media: artaquest-media.
- **Used by:** Media.php
- **Get / rotate:** dash.cloudflare.com → R2.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Uploads stay on this server.
- **Old name (still works):** `AQ_R2_BUCKET`

### `R2_ACCESS_KEY_ID`

- **Purpose:** R2 S3 access key ID. Rotate together with R2_SECRET_ACCESS_KEY.
- **Used by:** Media.php · uploads, avatars, media library (S3 PUT/GET/HEAD/DELETE/List/Copy)
- **Get / rotate:** dash.cloudflare.com → R2 → Manage R2 API tokens → Create token: permission Object Read & Write, applied to bucket artaquest-media ONLY. Save both halves, then delete the old token.
- **Rotation:** every 90 days (critical)
- **Need:** optional
- **If missing:** Uploads stay on this server; existing R2 media still serves from the CDN.
- **Old name (still works):** `AQ_R2_KEY`

### `R2_SECRET_ACCESS_KEY`

- **Purpose:** R2 S3 secret access key — the secret half of R2_ACCESS_KEY_ID.
- **Used by:** Media.php
- **Get / rotate:** Shown once when the R2 API token is created (see R2_ACCESS_KEY_ID).
- **Rotation:** every 90 days (critical)
- **Need:** optional
- **If missing:** Uploads stay on this server.
- **Old name (still works):** `AQ_R2_SECRET`

### `MEDIA_CDN_URL`

- **Purpose:** Public base URL media is served from (the bucket public URL or its custom domain), no trailing slash.
- **Used by:** Media.php, theme template-aq-app.php
- **Get / rotate:** dash.cloudflare.com → R2 → artaquest-media → Settings → Public access.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Media URLs point at this server.
- **Old name (still works):** `AQ_MEDIA_CDN`

### `CLOUDFLARE_API_TOKEN`

- **Purpose:** Cloudflare account API token — bucket usage on AQ Security and the bucket CORS rule.
- **Used by:** Media::usage, Media::ensure_cors
- **Get / rotate:** dash.cloudflare.com → Manage account → Account API tokens → Create: Account › Workers R2 Storage: Edit, plus Account › Account Analytics: Read; Account resources: this account only. Delete the old token after.
- **Rotation:** every 90 days (critical)
- **Need:** optional
- **If missing:** The storage usage card is blank. Uploads are unaffected.
- **Old name (still works):** `AQ_CF_API_TOKEN`

## Calls

Relay for room video calls when a direct connection fails. A Cloudflare TURN key OR a static TURN server; neither = direct (STUN) only.

### `CALLS_TURN_KEY_ID`

- **Purpose:** Cloudflare Realtime TURN key ID.
- **Used by:** Rooms::ice · GET /aq/v1/rooms/ice
- **Get / rotate:** dash.cloudflare.com → Realtime → TURN Server → Create key.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Calls are direct-only; some networks cannot connect.
- **Old name (still works):** `AQ_CF_TURN_KEY_ID`

### `CALLS_TURN_KEY_TOKEN`

- **Purpose:** Cloudflare Realtime TURN key API token (pairs with CALLS_TURN_KEY_ID).
- **Used by:** Rooms::ice · GET /aq/v1/rooms/ice
- **Get / rotate:** Shown once when the TURN key is created (see CALLS_TURN_KEY_ID).
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** As above.
- **Old name (still works):** `AQ_CF_TURN_KEY_TOKEN`

### `CALLS_TURN_URLS`

- **Purpose:** Static TURN server URLs, comma-separated — alternative to the Cloudflare TURN key.
- **Used by:** Rooms::ice
- **Get / rotate:** Your TURN provider.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** As above.
- **Old name (still works):** `AQ_TURN_URLS`

### `CALLS_TURN_USER`

- **Purpose:** Static TURN username.
- **Used by:** Rooms::ice
- **Get / rotate:** Your TURN provider.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** As above.
- **Old name (still works):** `AQ_TURN_USER`

### `CALLS_TURN_PASSWORD`

- **Purpose:** Static TURN password.
- **Used by:** Rooms::ice
- **Get / rotate:** Your TURN provider.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** As above.
- **Old name (still works):** `AQ_TURN_PASS`

## Google

Google sign-in and YouTube.

### `GOOGLE_SIGNIN_CLIENT_ID`

- **Purpose:** Google sign-in OAuth client ID — public, embedded in the sign-in button.
- **Used by:** Auth.php, theme template-aq-app.php · sign-in page
- **Get / rotate:** console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client IDs (Web).
- **Rotation:** no rotation
- **Need:** required
- **If missing:** "Sign in with Google" disappears.
- **Old name (still works):** `GOOGLE_OAUTH_CLIENT_ID`

### `YOUTUBE_SERVICE_ACCOUNT_JSON`

- **Purpose:** YouTube service-account JSON key — main auth for course videos and the view monitor.
- **Used by:** YouTube.php, Offline.php · course video sync, view monitor
- **Get / rotate:** console.cloud.google.com → IAM & Admin → Service accounts → the YouTube account → Keys → Add key (JSON); then delete the old key. YouTube Data API v3 must be enabled.
- **Rotation:** every 180 days (standard)
- **Need:** this or `YOUTUBE_API_KEY`
- **If missing:** Falls back to YOUTUBE_API_KEY; with neither, YouTube features answer "no_key".
- **Old name (still works):** `YOUTUBE_SA_JSON`

### `YOUTUBE_API_KEY`

- **Purpose:** YouTube Data API key — read-only public data; alternative to the service account, and the marketplace video feed.
- **Used by:** YouTube.php, Extra.php (marketplace)
- **Get / rotate:** console.cloud.google.com → APIs & Services → Credentials → API key, restricted to YouTube Data API v3.
- **Rotation:** every 365 days (low)
- **Need:** this or `YOUTUBE_SERVICE_ACCOUNT_JSON`
- **If missing:** Marketplace videos are hidden; YouTube features need the service account.

## Integrations

Publishing our work to Kaggle, GitHub gists and Zenodo.

### `KAGGLE_TOKEN`

- **Purpose:** Kaggle API token (KGAT_…) — dataset cards and reading public kernels.
- **Used by:** Kaggle.php, Extra.php, Kernel.php
- **Get / rotate:** kaggle.com/settings → API → Generate New Token; expire the old one.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** Kaggle cards and kernel runs are off.

### `KAGGLE_API_KEY`

- **Purpose:** Kaggle legacy API key — needed to PUSH notebooks as kernels (HTTP Basic with KAGGLE_USERNAME).
- **Used by:** Kaggle.php · notebook → kernel push
- **Get / rotate:** kaggle.com/settings → API → Create Legacy API Key (kaggle.json “key”). Expire the old one.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** Notebook pushes use KAGGLE_TOKEN, which Kaggle refuses for writes.
- **Old name (still works):** `KAGGLE_KEY`

### `KAGGLE_USERNAME`

- **Purpose:** Kaggle account the API key belongs to. Default artafather.
- **Used by:** Kaggle.php
- **Get / rotate:** kaggle.json “username”.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Default is used.

### `GITHUB_GIST_TOKEN`

- **Purpose:** GitHub token with ONLY the `gist` scope — mirrors submitted notebooks to public gists (one-click Colab).
- **Used by:** Gist.php, Kernel.php
- **Get / rotate:** github.com/settings/tokens → Generate new token (classic) → scope: gist only. Delete the old token.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** No gist mirror / Colab button.

### `ZENODO_TOKEN`

- **Purpose:** Zenodo personal token (deposit:write + deposit:actions) — mints DOIs for published research, notebooks and demos.
- **Used by:** Science.php, Notebook.php, Demo.php · publish flows
- **Get / rotate:** zenodo.org/account/settings/applications → Personal access tokens → New token with deposit:write and deposit:actions. Delete the old one.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** Published work gets no DOI.

## Feeds

Optional social feeds for the marketplace page. Dormant until set.

### `X_BEARER_TOKEN`

- **Purpose:** X (Twitter) app-only bearer token — images/videos feed on the marketplace.
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** developer.x.com → Projects & Apps → the app → Keys and tokens → Bearer token (Regenerate).
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** That feed is hidden.

### `REDDIT_CLIENT_ID`

- **Purpose:** Reddit app client ID — educational subreddit feed.
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** reddit.com/prefs/apps → a “script” app.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** That feed is hidden.

### `REDDIT_CLIENT_SECRET`

- **Purpose:** Reddit app client secret (pairs with REDDIT_CLIENT_ID).
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** reddit.com/prefs/apps → the app → secret.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** That feed is hidden.

### `IG_ACCESS_TOKEN`

- **Purpose:** Instagram Graph API token for our own account’s media.
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** developers.facebook.com → the app → Instagram Graph API → long-lived token.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** That feed is hidden.

### `IG_USER_ID`

- **Purpose:** Instagram business account ID (pairs with IG_ACCESS_TOKEN).
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** Graph API Explorer → me/accounts.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** That feed is hidden.

### `LINKEDIN_ACCESS_TOKEN`

- **Purpose:** LinkedIn token for our organisation’s posts.
- **Used by:** Extra.php (marketplace)
- **Get / rotate:** linkedin.com/developers → the app → Auth → token.
- **Rotation:** every 365 days (low)
- **Need:** optional
- **If missing:** That feed is hidden.

## Bot tokens

Tokens WE mint (openssl rand -hex 32). Each unlocks one set of routes for one outside bot; the same value is set on the bot's host.

### `BOT_ARTA_TOKEN`

- **Purpose:** Token the Arta brain sends (X-Arta-Token) to claim @arta mentions and post replies. ≥32 chars; same value as ARTA_REPLY_TOKEN on the brain.
- **Used by:** Arta.php · POST /aq/v1/arta/* · Arta brain (arta-brain/)
- **Get / rotate:** Mint: openssl rand -hex 32. Set it here AND in the brain’s env, then restart the brain.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** Mentions queue but nobody answers them.
- **Old name (still works):** `AQ_ARTA_REPLY_TOKEN`

### `BOT_ARTAMAIL_TOKEN`

- **Purpose:** Token ArtaMail sends to its ONE route, GET /aq/v1/secret/titan. ≥32 chars; not the Titan password.
- **Used by:** Vault::rest_titan · GET /aq/v1/secret/titan · ArtaMail
- **Get / rotate:** Mint: openssl rand -hex 32. Set it here AND in ArtaMail’s config.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** ArtaMail gets 401 and cannot read or send Titan mail.
- **Old name (still works):** `AQ_ARTAMAIL_TOKEN`

### `BOT_ARTASEARCH_TOKEN`

- **Purpose:** Token the ArtaSearch scan box sends (X-AQ-Alumni-Token) to POST /aq/v1/outreach/alumni/ingest. ≥32 chars.
- **Used by:** AlumniSearch.php · POST /aq/v1/outreach/alumni/ingest · ArtaSearch scan box
- **Get / rotate:** Mint: openssl rand -hex 32. Set it here AND on the scan box.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** Alumni ingest is refused.
- **Old name (still works):** `AQ_ALUMNI_INGEST_TOKEN`

### `BOT_WORKER_TOKEN`

- **Purpose:** Token the relay daemons send (X-AQ-Worker) to every `worker` route: relay/poll|complete|stream, translate, compete, chant, science review, shell roster. Unset = all of them closed.
- **Used by:** Rest::worker_ok, Relay.php · POST /aq/v1/relay/* · Arta relay VM, translation/review/compete daemons, ArtaShell VM
- **Get / rotate:** Mint: openssl rand -hex 32. Set it here AND on every relay daemon (same value).
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** Every relay daemon gets 401: Arta turns, translations, competition and science reviews, and ArtaShell rosters stop.
- **Old name (still works):** `AQ_WORKER_TOKEN`

## Arta relay

Where Arta turns and ArtaShell sessions are sent (endpoints, not credentials) and the secret that signs them.

### `ARTA_RELAY_SECRET`

- **Purpose:** Shared HMAC secret that signs relay and ArtaShell job tokens.
- **Used by:** Relay.php, Shell.php
- **Get / rotate:** Mint: openssl rand -hex 32. Set it here AND on the relay/shell VM.
- **Rotation:** every 180 days (standard)
- **Need:** optional
- **If missing:** Relay and shell jobs cannot be verified.
- **Old name (still works):** `AQ_TURN_SECRET`

### `ARTA_RELAY_URL`

- **Purpose:** Default Arta turn endpoint. A tier can override it with ARTA_RELAY_URL_<TIER>.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Turns wait for a polling daemon.
- **Old name (still works):** `AQ_TURN_URL`

### `ARTA_TOOLS_URL`

- **Purpose:** Default Arta TOOLS endpoint when a tier has none of its own.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Tool turns use the plain relay.
- **Old name (still works):** `AQ_TURN_URL_TOOLS`

### `ARTA_TOOLS_URL_LOW`

- **Purpose:** Arta tools endpoint — Low tier.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_TOOLS_URL_MEDIUM`

- **Purpose:** Arta tools endpoint — Medium tier.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_TOOLS_URL_HIGH`

- **Purpose:** Arta tools endpoint — High tier.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_TOOLS_URL_XHIGH`

- **Purpose:** Arta tools endpoint — X-High tier.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_TOOLS_URL_MAX`

- **Purpose:** Arta tools endpoint — Max tier.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_TOOLS_URL_WORKFLOW`

- **Purpose:** Arta tools endpoint — multi-agent Workflow turns.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ARTA_TOOLS_URL is used.

### `ARTA_BROKER_URL`

- **Purpose:** Broker endpoint passed to the relay with each tools turn.
- **Used by:** Relay.php
- **Get / rotate:** Your relay VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** No broker is passed.
- **Old name (still works):** `AQ_BROKER_URL`

### `ARTA_SHELL_URL`

- **Purpose:** ArtaShell endpoint (the member terminal).
- **Used by:** Shell.php · /aq/v1/shell/*
- **Get / rotate:** Your shell VM.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** ArtaShell is off.
- **Old name (still works):** `AQ_SHELL_URL`

## Encryption

Keys for data we encrypt ourselves.

### `TASK_SYNC_KEY`

- **Purpose:** Optional dedicated key for ArtaTask phone-sync blobs. Do NOT rotate on a clock: changing it strands rows until phones re-upload (docs/artatask-sync.md).
- **Used by:** TaskSync.php · /aq/v1/task-sync/* · ArtaTask app
- **Get / rotate:** Mint: openssl rand -base64 32.
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Blobs are encrypted with a key derived from wp-config AUTH_KEY/AUTH_SALT instead.
- **Old name (still works):** `AQ_TASK_SYNC_KEY`

## Flags

Switches: set = on. Not credentials.

### `FLAG_CASHOUT_FROZEN`

- **Purpose:** Set (any value) to freeze coin cash-outs during an incident.
- **Used by:** Economy.php, Extra.php, Integrity.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Cash-outs are open (normal).
- **Old name (still works):** `AQ_CASHOUT_FROZEN`

### `FLAG_ALLOW_PASSWORD_LOGIN`

- **Purpose:** RECOVERY ONLY — re-enables password logins. Must stay UNSET (password hashes are public).
- **Used by:** Auth.php, Health.php, Watchdog.php
- **Get / rotate:** —
- **Rotation:** no rotation
- **Need:** optional
- **If missing:** Password logins are off (normal).
- **Old name (still works):** `AQ_ALLOW_PASSWORD_LOGIN`

## Renamed on 2026-10-26

Old names keep resolving from the vault, the environment and `wp-config.php`. The first admin page load (or the next Watchdog run) moves vault entries to the new name — the ciphertext is copied unchanged and each move is written to the audit log by name only. A constant or env var with an old name keeps working; rename it at leisure.

| Old name | New name |
|---|---|
| `AQ_ACS_EMAIL_CONNECTION` | `MAIL_ACS_CONNECTION` |
| `AQ_ACS_EMAIL_SENDER` | `MAIL_ACS_SENDER` |
| `SMTP_PASS` | `MAIL_SMTP_PASSWORD` |
| `SMTP_HOST` | `MAIL_SMTP_HOST` |
| `SMTP_PORT` | `MAIL_SMTP_PORT` |
| `SMTP_USER` | `MAIL_SMTP_USER` |
| `TITAN_PASSWORD` | `MAIL_TITAN_PASSWORD` |
| `OPERATOR_EMAIL` | `MAIL_ALERTS_TO` |
| `AQ_R2_ACCOUNT` | `CLOUDFLARE_ACCOUNT_ID` |
| `AQ_R2_BUCKET` | `R2_BUCKET` |
| `AQ_R2_KEY` | `R2_ACCESS_KEY_ID` |
| `AQ_R2_SECRET` | `R2_SECRET_ACCESS_KEY` |
| `AQ_MEDIA_CDN` | `MEDIA_CDN_URL` |
| `AQ_CF_API_TOKEN` | `CLOUDFLARE_API_TOKEN` |
| `AQ_CF_TURN_KEY_ID` | `CALLS_TURN_KEY_ID` |
| `AQ_CF_TURN_KEY_TOKEN` | `CALLS_TURN_KEY_TOKEN` |
| `AQ_TURN_URLS` | `CALLS_TURN_URLS` |
| `AQ_TURN_USER` | `CALLS_TURN_USER` |
| `AQ_TURN_PASS` | `CALLS_TURN_PASSWORD` |
| `GOOGLE_OAUTH_CLIENT_ID` | `GOOGLE_SIGNIN_CLIENT_ID` |
| `YOUTUBE_SA_JSON` | `YOUTUBE_SERVICE_ACCOUNT_JSON` |
| `KAGGLE_KEY` | `KAGGLE_API_KEY` |
| `AQ_ARTA_REPLY_TOKEN` | `BOT_ARTA_TOKEN` |
| `AQ_ARTAMAIL_TOKEN` | `BOT_ARTAMAIL_TOKEN` |
| `AQ_ALUMNI_INGEST_TOKEN` | `BOT_ARTASEARCH_TOKEN` |
| `AQ_WORKER_TOKEN` | `BOT_WORKER_TOKEN` |
| `AQ_TURN_SECRET` | `ARTA_RELAY_SECRET` |
| `AQ_TURN_URL` | `ARTA_RELAY_URL` |
| `AQ_TURN_URL_TOOLS` | `ARTA_TOOLS_URL` |
| `AQ_BROKER_URL` | `ARTA_BROKER_URL` |
| `AQ_SHELL_URL` | `ARTA_SHELL_URL` |
| `AQ_TASK_SYNC_KEY` | `TASK_SYNC_KEY` |
| `AQ_CASHOUT_FROZEN` | `FLAG_CASHOUT_FROZEN` |
| `AQ_ALLOW_PASSWORD_LOGIN` | `FLAG_ALLOW_PASSWORD_LOGIN` |
| `AQ_TURN_URL_TOOLS_<TIER>` | `ARTA_TOOLS_URL_<TIER>` |
| `AQ_TURN_URL_<TIER>` | `ARTA_RELAY_URL_<TIER>` |

## Removed — no production code reads these

A stored value for one of these appears under **Unused — safe to forget** on AQ Security, never alarms, and is removed by **Forget** (one row) or **Forget all unused** (every unused row; each name is written to the audit log). An old-name copy whose new name already holds its own value is listed there too.

| Name | Why |
|---|---|
| `GOOGLE_OAUTH_CLIENT_SECRET` | No production code reads it: Google sign-in needs only the client ID, and the Meet integration it served is gone (its helper tools/google_oauth.mjs was removed too). |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | No production code reads it (the Calendar/Meet integration is gone). Also revoke it at myaccount.google.com → Security → Third-party access. |
| `HF_TOKEN` | HuggingFace was removed on 2026-08-02. Also delete the token at huggingface.co/settings/tokens. |
| `RECAPTCHA_SECRET` | No code reads it: sign-in is email code + Google + passkeys, with no reCAPTCHA check. |
