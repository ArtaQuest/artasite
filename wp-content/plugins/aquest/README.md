# ArtaQuest (plugin)

The entire ArtaQuest backend in one dependency-free plugin: LMS, economy, social,
i18n, funds, contributions, and an AI assistant. Replaces the 4,071-file MasterStudy
LMS bundle + WooCommerce.

## Where to start reading

1. **`src/Rest.php`** — `Rest::ROUTES` is the complete API surface in one table. Every
   endpoint, its method, auth level, and handler is here.
2. **`../../../ARCHITECTURE.md`** — the scaling design (custom tables, denormalized
   counters, cursor pagination, append-only ledgers, content-addressed i18n).
3. **`src/Schema.php`** — every table and index.

## File map (18 src classes + bootstrap, one domain each)

| File | Domain |
|------|--------|
| `aquest.php` | bootstrap: eager class load, activation → schema, `rest_api_init` → routes, i18n URL router, season cron, password hardening |
| `src/Schema.php` | versioned table install/migrate (`dbDelta`) |
| `src/Data.php` | query helpers: `page()` cursor, `bump()` counter, `upsert()`, json enc/dec |
| `src/Rest.php` | route table → domain methods; auth, rate-limit, cache headers |
| `src/Secrets.php` | secrets from env / wp-config constants (never the public DB) |
| `src/Auth.php` | passwordless sign-in (email code + Google), stateless sessions, password hardening |
| `src/Courses.php` | courses + lessons (read + authoring); per-course entry-fee price on the card |
| `src/Learn.php` | enrol (charges the entry fee), watch-gate progress, per-section discussion board (reply + upvote), certificate, rankings |
| `src/Economy.php` | coin + points ledgers, balances, tiers, leaderboard, reserve, podium rewards, ArtaBot metering |
| `src/Season.php` | competition seasons (new-moon reset) + archival |
| `src/Social.php` | global threads/comments/votes/follows, public profile |
| `src/I18n.php` | content-addressed translation mesh (~133 languages) + `/xx/` URL router |
| `src/Funds.php` | donations, bursaries, course entry-fee pricing, public financial transparency |
| `src/Extra.php` | DB explorer, certificates, outreach grants + ICS, creator ladder, coin world map, course checkout |
| `src/Notify.php` | per-user notification centre |
| `src/Meetings.php` | ArtaMeet — scheduled meetings; the E2EE room is bound at T-15m and released after |
| `src/Calendar.php` | ArtaCalendar — one dated view over meetings, claimed grant deadlines and entered challenges; owns no data |
| `src/Tickets.php` | Claude-triaged contribution tickets (bug/feature/content/suggestion) |
| `src/Assistant.php` | ArtaBot — AI assistant (Claude), coin-metered |

## Payments & payouts (Stripe)

All payment secrets come from the environment (`Secrets::get`), **never** the public DB. Set these as
env vars or `wp-config.php` constants:

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` (`sk_…`) | server-side API key — enables all payments |
| `STRIPE_PUBLISHABLE_KEY` (`pk_…`) | browser-safe key; its prefix decides live/test mode |
| `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | verifies inbound webhooks (HMAC-SHA256) |
| `AQ_CASHOUT_FROZEN` (optional) | set to any value to freeze cash-out in an emergency (no payouts; sell() refuses without debiting) |

**Money in (buy coins / donate)** → hosted Stripe Checkout (`Stripe::create_session`). The browser is
redirected; on return the session is verified (`GET /stripe-verify`) and the webhook is the reliable
backstop. Fulfilment (`Extra::fulfil_session`) is idempotent per `stripe:<session>` ledger ref, so the
return *and* the webhook can both fire safely. Minting bumps the full-reserve gold backing in lockstep.

**Money out (cash out coins)** → Stripe **Connect** (Express) transfers. First cash-out sends the member
through Stripe-hosted onboarding (`POST /coins/payout/connect`); once `payouts_enabled`, `POST /coins/sell`
moves money FIRST (a Connect transfer, with an Idempotency-Key) and only then debits the coins — so a coin
is never taken without a real payout behind it. `record_payout` is idempotent per `stripe_tr:<id>` and a
per-user lock serialises concurrent sells. Redeeming shrinks the gold backing in lockstep.

**Webhook**: point a Stripe endpoint at `POST /wp-json/aq/v1/stripe/webhook` subscribed to
`checkout.session.completed` (fulfilment) and `account.updated` (cash-out readiness). Confirm the whole
system from one call: `GET /wp-json/aq/v1/stripe/status` (masked booleans only — never a secret value).
Note: Connect transfers draw on the platform's Stripe balance, which is funded by coin purchases.

## Conventions

- All SQL via `$wpdb->prepare()`; input sanitized; output escaped.
- Lists return `{ items, next }` keyset cursors — never page numbers / OFFSET.
- Money/points are append-only ledgers — balances are `SUM(delta)`, never mutated rows.
- Bump `Schema::VERSION` to migrate; `dbDelta` only adds/widens, never drops.

## Local dev

```bash
studio wp plugin activate aquest
studio wp eval 'echo (new WP_REST_Request("GET","/aq/v1/courses"))->get_route();'
curl -s http://localhost:PORT/wp-json/aq/v1/courses | jq
```
