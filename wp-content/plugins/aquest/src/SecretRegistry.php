<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * THE list of secrets and settings the platform reads — one place, grouped by purpose.
 *
 * Who does what:
 *   SecretRegistry (this file) — DEFINITIONS only: name, group, purpose, tier, who reads it, where to
 *                                get/rotate it at the issuer, what breaks without it, old names.
 *   Secrets                    — RESOLUTION: Secrets::get('NAME') → vault, then env, then wp-config.
 *   Vault                      — STORAGE: the encrypted vault file + the wp-admin → AQ Security page.
 *   Watchdog                   — ALARMS: rotation due, compromised, vault-file tamper, leaks, traps.
 * docs/SECRETS.md is GENERATED from this file (php wp-content/plugins/aquest/tools/secrets-doc.php
 * --write) and preflight fails when the two disagree, so the page, the code and the doc never drift.
 *
 * Rule for adding a key: every NAME here must be read by code that runs on artaquest.com (a page,
 * a cron job, or a route an outside bot calls). A local script reads its own environment variable
 * and is not listed. No "AQ_" prefix (operator 2026-10-26: redundant).
 *
 * TIER → rotation clock (operator 2026-10-26: "only rotate every 90 days the absolute important ones"):
 *   critical 90 d  — moves money, sends mail as us, or writes our storage/Cloudflare account
 *   standard 180 d — one bot, one route, or one integration
 *   low      365 d — a narrow token that only publishes our own public work, or reads public data
 *   none     —      not a credential: an identifier, address, endpoint, publishable key or flag
 * NEED: 'required' (Health fails without it) · 'optional' · or ANOTHER NAME that covers the same need.
 */
final class SecretRegistry {

	const ROTATE = [ 'critical' => 90, 'standard' => 180, 'low' => 365, 'none' => 0 ];

	/** Order = page order. GROUP => one line about the group. */
	const GROUPS = [
		'Payments'     => 'Stripe — coin purchases, donations, cash-outs.',
		'Email'        => 'Platform mail goes out through Azure (ACS); SMTP is the fallback. Either one is enough.',
		'Cloudflare'   => 'Media storage on R2 (bucket artaquest-media) and the account API token. All four storage values switch uploads to R2; with any one missing, files stay on this server.',
		'Calls'        => 'Relay for room video calls when a direct connection fails. A Cloudflare TURN key OR a static TURN server; neither = direct (STUN) only.',
		'Google'       => 'Google sign-in and YouTube.',
		'Integrations' => 'Publishing our work to Kaggle, GitHub gists and Zenodo.',
		'Feeds'        => 'Optional social feeds for the marketplace page. Dormant until set.',
		'Bot tokens'   => 'Tokens WE mint (openssl rand -hex 32). Each unlocks one set of routes for one outside bot; the same value is set on the bot\'s host.',
		'Arta relay'   => 'Where Arta turns and ArtaShell sessions are sent (endpoints, not credentials) and the secret that signs them.',
		'Encryption'   => 'Keys for data we encrypt ourselves.',
		'Flags'        => 'Switches: set = on. Not credentials.',
	];

	/**
	 * NAME => [ group, tier, need, purpose, used by (file · route · bot), issuer (where to get/rotate + scopes), breaks when missing ]
	 */
	const KEYS = [
		// ── Payments ────────────────────────────────────────────────────────────────────────────
		'STRIPE_SECRET_KEY' => [ 'Payments', 'critical', 'required',
			'Stripe live secret key (sk_live_…) — server-side calls for coin purchases, donations and cash-outs.',
			'Stripe.php, Economy.php, Extra.php · checkout + cash-out routes',
			'dashboard.stripe.com → Developers → API keys → Roll secret key (or a restricted key with Checkout Sessions, PaymentIntents, Payouts/Transfers write).',
			'Paid checkout, donations and cash-outs are off (Stripe::enabled() is false).' ],
		'STRIPE_WEBHOOK_SECRET' => [ 'Payments', 'critical', 'required',
			'Stripe webhook signing secret (whsec_…) — proves a payment event really came from Stripe.',
			'Stripe.php, Extra::stripe_webhook · POST /aq/v1/stripe/webhook',
			'dashboard.stripe.com → Developers → Webhooks → the artaquest.com/wp-json/aq/v1/stripe/webhook endpoint → Roll secret.',
			'Payment events are rejected, so paid coins are not credited.' ],
		'STRIPE_PUBLISHABLE_KEY' => [ 'Payments', 'none', 'required',
			'Stripe publishable key (pk_live_…) — public by design, sent to browsers. Replace it when the secret key is rolled.',
			'Stripe.php, Extra.php · checkout page',
			'dashboard.stripe.com → Developers → API keys.',
			'The browser cannot open Stripe checkout.' ],

		// ── Email ───────────────────────────────────────────────────────────────────────────────
		'MAIL_ACS_CONNECTION' => [ 'Email', 'critical', 'MAIL_SMTP_PASSWORD',
			'Azure Communication Services connection string (endpoint=…;accesskey=…) — main sender for all platform email.',
			'Mailer.php · every outgoing email (sign-in codes, alerts, notices)',
			'portal.azure.com → the Communication Services resource → Settings → Keys → Regenerate the secondary key, switch to it, then regenerate the primary.',
			'Mail falls back to SMTP; with SMTP unset too, sign-in codes and alerts are not delivered.' ],
		'MAIL_ACS_SENDER' => [ 'Email', 'none', 'optional',
			'Verified ACS sender address, e.g. DoNotReply@mail.artaquest.org.',
			'Mailer.php',
			'portal.azure.com → Email Communication Service → the mail.artaquest.org domain → MailFrom addresses.',
			'The default DoNotReply@ address is used.' ],
		'MAIL_SMTP_PASSWORD' => [ 'Email', 'critical', 'MAIL_ACS_CONNECTION',
			'SMTP password (app password) for the support@ mailbox — the fallback sender when ACS refuses.',
			'Mailer.php · every outgoing email when ACS is unset or fails',
			'The mailbox provider (default Google: myaccount.google.com → Security → App passwords). Revoke the old app password after.',
			'No fallback when ACS fails.' ],
		'MAIL_SMTP_HOST' => [ 'Email', 'none', 'optional', 'SMTP host. Default smtp.gmail.com.', 'Mailer.php', '—', 'Default is used.' ],
		'MAIL_SMTP_PORT' => [ 'Email', 'none', 'optional', 'SMTP port. Default 587 (STARTTLS); 465 = SSL.', 'Mailer.php', '—', 'Default is used.' ],
		'MAIL_SMTP_USER' => [ 'Email', 'none', 'optional', 'SMTP username. Default support@artaquest.org.', 'Mailer.php', '—', 'Default is used.' ],
		'MAIL_TITAN_PASSWORD' => [ 'Email', 'critical', 'optional',
			'Titan mailbox password — handed ONLY to the ArtaMail bot, which reads and sends the Titan mailboxes.',
			'Vault::rest_titan · GET /aq/v1/secret/titan · ArtaMail',
			'Titan admin panel (control.titan.email) → the mailbox → Reset password. ArtaMail picks the new one up on its next call.',
			'ArtaMail cannot log in to Titan (the route answers 404).' ],
		'MAIL_ALERTS_TO' => [ 'Email', 'none', 'optional',
			'Where security and ops alerts are emailed.', 'Mailer.php, Watchdog.php', '—', 'Alerts go to the site admin email.' ],

		// ── Cloudflare ──────────────────────────────────────────────────────────────────────────
		'CLOUDFLARE_ACCOUNT_ID' => [ 'Cloudflare', 'none', 'optional',
			'Cloudflare account ID (32 hex) that owns the R2 bucket.', 'Media.php · every upload and media URL',
			'dash.cloudflare.com → any page → Account ID (right column).', 'Uploads stay on this server.' ],
		'R2_BUCKET' => [ 'Cloudflare', 'none', 'optional',
			'R2 bucket for media: artaquest-media.', 'Media.php', 'dash.cloudflare.com → R2.', 'Uploads stay on this server.' ],
		'R2_ACCESS_KEY_ID' => [ 'Cloudflare', 'critical', 'optional',
			'R2 S3 access key ID. Rotate together with R2_SECRET_ACCESS_KEY.',
			'Media.php · uploads, avatars, media library (S3 PUT/GET/HEAD/DELETE/List/Copy)',
			'dash.cloudflare.com → R2 → Manage R2 API tokens → Create token: permission Object Read & Write, applied to bucket artaquest-media ONLY. Save both halves, then delete the old token.',
			'Uploads stay on this server; existing R2 media still serves from the CDN.' ],
		'R2_SECRET_ACCESS_KEY' => [ 'Cloudflare', 'critical', 'optional',
			'R2 S3 secret access key — the secret half of R2_ACCESS_KEY_ID.', 'Media.php', 'Shown once when the R2 API token is created (see R2_ACCESS_KEY_ID).',
			'Uploads stay on this server.' ],
		'MEDIA_CDN_URL' => [ 'Cloudflare', 'none', 'optional',
			'Public base URL media is served from (the bucket public URL or its custom domain), no trailing slash.',
			'Media.php, theme template-aq-app.php', 'dash.cloudflare.com → R2 → artaquest-media → Settings → Public access.',
			'Media URLs point at this server.' ],
		'CLOUDFLARE_API_TOKEN' => [ 'Cloudflare', 'critical', 'optional',
			'Cloudflare account API token — bucket usage on AQ Security and the bucket CORS rule.',
			'Media::usage, Media::ensure_cors',
			'dash.cloudflare.com → Manage account → Account API tokens → Create: Account › Workers R2 Storage: Edit, plus Account › Account Analytics: Read; Account resources: this account only. Delete the old token after.',
			'The storage usage card is blank. Uploads are unaffected.' ],

		// ── Calls ───────────────────────────────────────────────────────────────────────────────
		'CALLS_TURN_KEY_ID' => [ 'Calls', 'none', 'optional',
			'Cloudflare Realtime TURN key ID.', 'Rooms::ice · GET /aq/v1/rooms/ice',
			'dash.cloudflare.com → Realtime → TURN Server → Create key.', 'Calls are direct-only; some networks cannot connect.' ],
		'CALLS_TURN_KEY_TOKEN' => [ 'Calls', 'standard', 'optional',
			'Cloudflare Realtime TURN key API token (pairs with CALLS_TURN_KEY_ID).', 'Rooms::ice · GET /aq/v1/rooms/ice',
			'Shown once when the TURN key is created (see CALLS_TURN_KEY_ID).', 'As above.' ],
		'CALLS_TURN_URLS' => [ 'Calls', 'none', 'optional',
			'Static TURN server URLs, comma-separated — alternative to the Cloudflare TURN key.', 'Rooms::ice', 'Your TURN provider.', 'As above.' ],
		'CALLS_TURN_USER' => [ 'Calls', 'none', 'optional', 'Static TURN username.', 'Rooms::ice', 'Your TURN provider.', 'As above.' ],
		'CALLS_TURN_PASSWORD' => [ 'Calls', 'standard', 'optional', 'Static TURN password.', 'Rooms::ice', 'Your TURN provider.', 'As above.' ],

		// ── Google ──────────────────────────────────────────────────────────────────────────────
		'GOOGLE_SIGNIN_CLIENT_ID' => [ 'Google', 'none', 'required',
			'Google sign-in OAuth client ID — public, embedded in the sign-in button.',
			'Auth.php, theme template-aq-app.php · sign-in page',
			'console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client IDs (Web).',
			'"Sign in with Google" disappears.' ],
		'YOUTUBE_SERVICE_ACCOUNT_JSON' => [ 'Google', 'standard', 'YOUTUBE_API_KEY',
			'YouTube service-account JSON key — main auth for course videos and the view monitor.',
			'YouTube.php, Offline.php · course video sync, view monitor',
			'console.cloud.google.com → IAM & Admin → Service accounts → the YouTube account → Keys → Add key (JSON); then delete the old key. YouTube Data API v3 must be enabled.',
			'Falls back to YOUTUBE_API_KEY; with neither, YouTube features answer "no_key".' ],
		'YOUTUBE_API_KEY' => [ 'Google', 'low', 'YOUTUBE_SERVICE_ACCOUNT_JSON',
			'YouTube Data API key — read-only public data; alternative to the service account, and the marketplace video feed.',
			'YouTube.php, Extra.php (marketplace)',
			'console.cloud.google.com → APIs & Services → Credentials → API key, restricted to YouTube Data API v3.',
			'Marketplace videos are hidden; YouTube features need the service account.' ],

		// ── Integrations ────────────────────────────────────────────────────────────────────────
		'KAGGLE_TOKEN' => [ 'Integrations', 'low', 'optional',
			'Kaggle API token (KGAT_…) — dataset cards and reading public kernels.',
			'Kaggle.php, Extra.php, Kernel.php',
			'kaggle.com/settings → API → Generate New Token; expire the old one.',
			'Kaggle cards and kernel runs are off.' ],
		'KAGGLE_API_KEY' => [ 'Integrations', 'standard', 'optional',
			'Kaggle legacy API key — needed to PUSH notebooks as kernels (HTTP Basic with KAGGLE_USERNAME).',
			'Kaggle.php · notebook → kernel push',
			'kaggle.com/settings → API → Create Legacy API Key (kaggle.json “key”). Expire the old one.',
			'Notebook pushes use KAGGLE_TOKEN, which Kaggle refuses for writes.' ],
		'KAGGLE_USERNAME' => [ 'Integrations', 'none', 'optional',
			'Kaggle account the API key belongs to. Default artafather.', 'Kaggle.php', 'kaggle.json “username”.', 'Default is used.' ],
		'GITHUB_GIST_TOKEN' => [ 'Integrations', 'low', 'optional',
			'GitHub token with ONLY the `gist` scope — mirrors submitted notebooks to public gists (one-click Colab).',
			'Gist.php, Kernel.php',
			'github.com/settings/tokens → Generate new token (classic) → scope: gist only. Delete the old token.',
			'No gist mirror / Colab button.' ],
		'ZENODO_TOKEN' => [ 'Integrations', 'low', 'optional',
			'Zenodo personal token (deposit:write + deposit:actions) — mints DOIs for published research, notebooks and demos.',
			'Science.php, Notebook.php, Demo.php · publish flows',
			'zenodo.org/account/settings/applications → Personal access tokens → New token with deposit:write and deposit:actions. Delete the old one.',
			'Published work gets no DOI.' ],

		// ── Feeds (dormant until set) ───────────────────────────────────────────────────────────
		'X_BEARER_TOKEN' => [ 'Feeds', 'low', 'optional',
			'X (Twitter) app-only bearer token — images/videos feed on the marketplace.', 'Extra.php (marketplace)',
			'developer.x.com → Projects & Apps → the app → Keys and tokens → Bearer token (Regenerate).', 'That feed is hidden.' ],
		'REDDIT_CLIENT_ID' => [ 'Feeds', 'none', 'optional',
			'Reddit app client ID — educational subreddit feed.', 'Extra.php (marketplace)', 'reddit.com/prefs/apps → a “script” app.', 'That feed is hidden.' ],
		'REDDIT_CLIENT_SECRET' => [ 'Feeds', 'low', 'optional',
			'Reddit app client secret (pairs with REDDIT_CLIENT_ID).', 'Extra.php (marketplace)', 'reddit.com/prefs/apps → the app → secret.', 'That feed is hidden.' ],
		'IG_ACCESS_TOKEN' => [ 'Feeds', 'low', 'optional',
			'Instagram Graph API token for our own account’s media.', 'Extra.php (marketplace)', 'developers.facebook.com → the app → Instagram Graph API → long-lived token.', 'That feed is hidden.' ],
		'IG_USER_ID' => [ 'Feeds', 'none', 'optional',
			'Instagram business account ID (pairs with IG_ACCESS_TOKEN).', 'Extra.php (marketplace)', 'Graph API Explorer → me/accounts.', 'That feed is hidden.' ],
		'LINKEDIN_ACCESS_TOKEN' => [ 'Feeds', 'low', 'optional',
			'LinkedIn token for our organisation’s posts.', 'Extra.php (marketplace)', 'linkedin.com/developers → the app → Auth → token.', 'That feed is hidden.' ],

		// ── Bot tokens ──────────────────────────────────────────────────────────────────────────
		'BOT_ARTA_TOKEN' => [ 'Bot tokens', 'standard', 'optional',
			'Token the Arta brain sends (X-Arta-Token) to claim @arta mentions and post replies. ≥32 chars; same value as ARTA_REPLY_TOKEN on the brain.',
			'Arta.php · POST /aq/v1/arta/* · Arta brain (arta-brain/)',
			'Mint: openssl rand -hex 32. Set it here AND in the brain’s env, then restart the brain.',
			'Mentions queue but nobody answers them.' ],
		'BOT_ARTAMAIL_TOKEN' => [ 'Bot tokens', 'standard', 'optional',
			'Token ArtaMail sends to its ONE route, GET /aq/v1/secret/titan. ≥32 chars; not the Titan password.',
			'Vault::rest_titan · GET /aq/v1/secret/titan · ArtaMail',
			'Mint: openssl rand -hex 32. Set it here AND in ArtaMail’s config.',
			'ArtaMail gets 401 and cannot read or send Titan mail.' ],
		'BOT_ARTASEARCH_TOKEN' => [ 'Bot tokens', 'standard', 'optional',
			'Token the ArtaSearch scan box sends (X-AQ-Alumni-Token) to POST /aq/v1/outreach/alumni/ingest. ≥32 chars.',
			'AlumniSearch.php · POST /aq/v1/outreach/alumni/ingest · ArtaSearch scan box',
			'Mint: openssl rand -hex 32. Set it here AND on the scan box.',
			'Alumni ingest is refused.' ],
		'BOT_WORKER_TOKEN' => [ 'Bot tokens', 'standard', 'optional',
			'Token the relay daemons send (X-AQ-Worker) to every `worker` route: relay/poll|complete|stream, translate, compete, chant, science review, shell roster. Unset = all of them closed.',
			'Rest::worker_ok, Relay.php · POST /aq/v1/relay/* · Arta relay VM, translation/review/compete daemons, ArtaShell VM',
			'Mint: openssl rand -hex 32. Set it here AND on every relay daemon (same value).',
			'Every relay daemon gets 401: Arta turns, translations, competition and science reviews, and ArtaShell rosters stop.' ],

		// ── Arta relay ──────────────────────────────────────────────────────────────────────────
		'ARTA_RELAY_SECRET' => [ 'Arta relay', 'standard', 'optional',
			'Shared HMAC secret that signs relay and ArtaShell job tokens.',
			'Relay.php, Shell.php',
			'Mint: openssl rand -hex 32. Set it here AND on the relay/shell VM.',
			'Relay and shell jobs cannot be verified.' ],
		'ARTA_RELAY_URL' => [ 'Arta relay', 'none', 'optional',
			'Default Arta turn endpoint. A tier can override it with ARTA_RELAY_URL_<TIER>.', 'Relay.php', 'Your relay VM.', 'Turns wait for a polling daemon.' ],
		'ARTA_TOOLS_URL' => [ 'Arta relay', 'none', 'optional',
			'Default Arta TOOLS endpoint when a tier has none of its own.', 'Relay.php', 'Your relay VM.', 'Tool turns use the plain relay.' ],
		'ARTA_TOOLS_URL_LOW'      => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — Low tier.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_TOOLS_URL_MEDIUM'   => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — Medium tier.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_TOOLS_URL_HIGH'     => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — High tier.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_TOOLS_URL_XHIGH'    => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — X-High tier.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_TOOLS_URL_MAX'      => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — Max tier.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_TOOLS_URL_WORKFLOW' => [ 'Arta relay', 'none', 'optional', 'Arta tools endpoint — multi-agent Workflow turns.', 'Relay.php', 'Your relay VM.', 'ARTA_TOOLS_URL is used.' ],
		'ARTA_BROKER_URL' => [ 'Arta relay', 'none', 'optional',
			'Broker endpoint passed to the relay with each tools turn.', 'Relay.php', 'Your relay VM.', 'No broker is passed.' ],
		'ARTA_SHELL_URL' => [ 'Arta relay', 'none', 'optional',
			'ArtaShell endpoint (the member terminal).', 'Shell.php · /aq/v1/shell/*', 'Your shell VM.', 'ArtaShell is off.' ],

		// ── Encryption ──────────────────────────────────────────────────────────────────────────
		'TASK_SYNC_KEY' => [ 'Encryption', 'none', 'optional',
			'Optional dedicated key for ArtaTask phone-sync blobs. Do NOT rotate on a clock: changing it strands rows until phones re-upload (docs/artatask-sync.md).',
			'TaskSync.php · /aq/v1/task-sync/* · ArtaTask app',
			'Mint: openssl rand -base64 32.', 'Blobs are encrypted with a key derived from wp-config AUTH_KEY/AUTH_SALT instead.' ],

		// ── Flags ───────────────────────────────────────────────────────────────────────────────
		'FLAG_CASHOUT_FROZEN' => [ 'Flags', 'none', 'optional',
			'Set (any value) to freeze coin cash-outs during an incident.', 'Economy.php, Extra.php, Integrity.php', '—', 'Cash-outs are open (normal).' ],
		'FLAG_ALLOW_PASSWORD_LOGIN' => [ 'Flags', 'none', 'optional',
			'RECOVERY ONLY — re-enables password logins. Must stay UNSET (password hashes are public).', 'Auth.php, Health.php, Watchdog.php', '—', 'Password logins are off (normal).' ],
	];

	/** NEW NAME => [ old names ]. Every old name keeps resolving (vault, environment, wp-config). */
	const ALIASES = [
		'MAIL_ACS_CONNECTION'          => [ 'AQ_ACS_EMAIL_CONNECTION' ],
		'MAIL_ACS_SENDER'              => [ 'AQ_ACS_EMAIL_SENDER' ],
		'MAIL_SMTP_PASSWORD'           => [ 'SMTP_PASS' ],
		'MAIL_SMTP_HOST'               => [ 'SMTP_HOST' ],
		'MAIL_SMTP_PORT'               => [ 'SMTP_PORT' ],
		'MAIL_SMTP_USER'               => [ 'SMTP_USER' ],
		'MAIL_TITAN_PASSWORD'          => [ 'TITAN_PASSWORD' ],
		'MAIL_ALERTS_TO'               => [ 'OPERATOR_EMAIL' ],
		'CLOUDFLARE_ACCOUNT_ID'        => [ 'AQ_R2_ACCOUNT' ],
		'R2_BUCKET'                    => [ 'AQ_R2_BUCKET' ],
		'R2_ACCESS_KEY_ID'             => [ 'AQ_R2_KEY' ],
		'R2_SECRET_ACCESS_KEY'         => [ 'AQ_R2_SECRET' ],
		'MEDIA_CDN_URL'                => [ 'AQ_MEDIA_CDN' ],
		'CLOUDFLARE_API_TOKEN'         => [ 'AQ_CF_API_TOKEN' ],
		'CALLS_TURN_KEY_ID'            => [ 'AQ_CF_TURN_KEY_ID' ],
		'CALLS_TURN_KEY_TOKEN'         => [ 'AQ_CF_TURN_KEY_TOKEN' ],
		'CALLS_TURN_URLS'              => [ 'AQ_TURN_URLS' ],
		'CALLS_TURN_USER'              => [ 'AQ_TURN_USER' ],
		'CALLS_TURN_PASSWORD'          => [ 'AQ_TURN_PASS' ],
		'GOOGLE_SIGNIN_CLIENT_ID'      => [ 'GOOGLE_OAUTH_CLIENT_ID' ],
		'YOUTUBE_SERVICE_ACCOUNT_JSON' => [ 'YOUTUBE_SA_JSON' ],
		'KAGGLE_API_KEY'               => [ 'KAGGLE_KEY' ],
		'BOT_ARTA_TOKEN'               => [ 'AQ_ARTA_REPLY_TOKEN' ],
		'BOT_ARTAMAIL_TOKEN'           => [ 'AQ_ARTAMAIL_TOKEN' ],
		'BOT_ARTASEARCH_TOKEN'         => [ 'AQ_ALUMNI_INGEST_TOKEN' ],
		'BOT_WORKER_TOKEN'             => [ 'AQ_WORKER_TOKEN' ],
		'ARTA_RELAY_SECRET'            => [ 'AQ_TURN_SECRET' ],
		'ARTA_RELAY_URL'               => [ 'AQ_TURN_URL' ],
		'ARTA_TOOLS_URL'               => [ 'AQ_TURN_URL_TOOLS' ],
		'ARTA_BROKER_URL'              => [ 'AQ_BROKER_URL' ],
		'ARTA_SHELL_URL'               => [ 'AQ_SHELL_URL' ],
		'TASK_SYNC_KEY'                => [ 'AQ_TASK_SYNC_KEY' ],
		'FLAG_CASHOUT_FROZEN'          => [ 'AQ_CASHOUT_FROZEN' ],
		'FLAG_ALLOW_PASSWORD_LOGIN'    => [ 'AQ_ALLOW_PASSWORD_LOGIN' ],
	];

	/** Per-tier relay names built at runtime (Relay.php). The TOOLS prefix is listed first: it is the longer old prefix. */
	const ALIAS_PREFIXES = [ 'ARTA_TOOLS_URL_' => 'AQ_TURN_URL_TOOLS_', 'ARTA_RELAY_URL_' => 'AQ_TURN_URL_' ];

	/** Names NO production code reads. A stored value shows under "Unused — safe to forget" and never alarms. */
	const RETIRED = [
		'GOOGLE_OAUTH_CLIENT_SECRET' => 'No production code reads it: Google sign-in needs only the client ID, and the Meet integration it served is gone (its helper tools/google_oauth.mjs was removed too).',
		'GOOGLE_OAUTH_REFRESH_TOKEN' => 'No production code reads it (the Calendar/Meet integration is gone). Also revoke it at myaccount.google.com → Security → Third-party access.',
		'HF_TOKEN'                   => 'HuggingFace was removed on 2026-08-02. Also delete the token at huggingface.co/settings/tokens.',
		'RECAPTCHA_SECRET'           => 'No code reads it: sign-in is email code + Google + passkeys, with no reCAPTCHA check.',
	];

	/** Normalised spec for a name (registered or not). */
	public static function spec( $name ) {
		$k = self::KEYS[ $name ] ?? null;
		if ( ! $k ) {
			return [ 'group' => 'Other', 'tier' => 'low', 'days' => 365, 'need' => 'optional', 'alt' => '', 'desc' => '(custom — not in the registry; Forget it if nothing outside this site uses it)', 'used_by' => '', 'issuer' => '', 'breaks' => '', 'registered' => false ];
		}
		$need = $k[2];
		return [
			'group' => $k[0], 'tier' => $k[1], 'days' => self::ROTATE[ $k[1] ],
			'need' => in_array( $need, [ 'required', 'optional' ], true ) ? $need : 'alternative',
			'alt'  => in_array( $need, [ 'required', 'optional' ], true ) ? '' : $need,
			'desc' => $k[3], 'used_by' => $k[4], 'issuer' => $k[5], 'breaks' => $k[6], 'registered' => true,
		];
	}

	/** [ new name, ...old names ] for any name, old or new. */
	public static function names( $name ) {
		$name = (string) $name;
		static $rev = null;
		if ( $rev === null ) {
			$rev = [];
			foreach ( self::ALIASES as $canon => $olds ) { foreach ( $olds as $o ) { $rev[ $o ] = $canon; } }
		}
		$canon = $rev[ $name ] ?? null;
		if ( $canon === null ) {
			$canon = $name;
			foreach ( self::ALIAS_PREFIXES as $new => $old ) {
				if ( strpos( $name, $old ) === 0 && strlen( $name ) > strlen( $old ) ) { $canon = $new . substr( $name, strlen( $old ) ); break; }
			}
		}
		$out = [ $canon ];
		foreach ( self::ALIASES[ $canon ] ?? [] as $o ) { $out[] = $o; }
		foreach ( self::ALIAS_PREFIXES as $new => $old ) {
			if ( strpos( $canon, $new ) === 0 && strlen( $canon ) > strlen( $new ) ) { $out[] = $old . substr( $canon, strlen( $new ) ); }
		}
		return array_values( array_unique( $out ) );
	}
}
