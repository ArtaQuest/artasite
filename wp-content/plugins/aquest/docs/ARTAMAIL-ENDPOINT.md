# ArtaMail Titan secret endpoint

`GET /wp-json/aq/v1/secret/titan` — the single, token-gated way the ArtaMail campaign sender (and its
live e2e test) reads the Titan mailbox password at runtime, so the password lives ONLY in this vault
(never in GitHub Actions secrets, never in Cloudflare KV).

## What it does
- Returns **only** `{"password": "<TITAN_PASSWORD>"}` — the arash@ / support@artaquest.org Titan
  password. There is deliberately **no** generic `secret/{name}` route.
- Handler: `AQ\Vault::rest_titan()` in `src/Vault.php`. Route registered in `src/Rest.php`
  (`[ 'GET', 'secret/titan', 'Vault::rest_titan', 'public' ]` — `public` so failed attempts are
  audited, with all gating inside the handler).

## Auth & hardening
- **Token** (not the password): `AQ_ARTAMAIL_TOKEN` (a Vault registry entry, ≥32 chars), presented as
  `Authorization: Bearer <token>` or `X-AQ-ArtaMail: <token>`, compared with `hash_equals`. Mirrors
  the existing `AQ_WORKER_TOKEN` / `AQ_ARTA_REPLY_TOKEN` machine-token pattern.
- **HTTPS required** (`is_ssl()` or `X-Forwarded-Proto: https`); plain HTTP allowed only under local
  `WP_DEBUG`.
- **`Cache-Control: no-store`** on every response (handler returns a `WP_REST_Response`, so the
  dispatcher adds no cacheable header).
- **Rate limit** 10/hour/IP via `Rest::throttle` transients.
- **Audit** via `Watchdog::note("secret/titan <ok|fail:…> ip=…")` — timestamp, IP, result, and
  **never the value**. The password appears in no log or error message.

## Responses
`200` secret · `401` missing token · `403` bad/too-short token or non-HTTPS · `404` secret unset ·
`429` rate limited.

## Operator setup (wp-admin → ArtaQuest Security)
1. Set **`TITAN_PASSWORD`** = the arash@/support@ Titan mailbox password (write-only here).
2. Set **`AQ_ARTAMAIL_TOKEN`** = a random ≥32-char token (this is what ArtaMail presents; NOT the
   Titan password).

## Tests
`php wp-content/plugins/aquest/tools/test-secret-titan.php` — covers no/bad/short/good token, rate
limit, unset secret, no-store header, and that the value never reaches the audit log.

## Smoke test after deploy
`curl -s -o /dev/null -w '%{http_code}\n' https://artaquest.com/wp-json/aq/v1/secret/titan` → **401**.

The ArtaMail client side lives in the `artamail` repo: `Sources/ArtaMailCore/VaultClient.swift` and
`docs/VAULT-INTEGRATION.md`.
