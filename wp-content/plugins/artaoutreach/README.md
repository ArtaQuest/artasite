# ArtaOutreach

Admin-only review queue for accounts LinkedIn, Facebook, Instagram and X suggested to Arash.
Each account is included in or excluded from the study by hand on **wp-admin → ArtaOutreach**.
The ArtaTask phone app only sends to accounts marked *included*. This plugin contains no
discovery or scraping code; it only stores what is posted to it.

## Privacy

Rows describe third parties, so table `{prefix}aq_artaoutreach` is in
`AQ\Extra::PRIVATE_TABLES` (withheld from `/data`, `/schema`, `/offline`). Every route and the
admin page require `manage_options`.

## Activate

wp-admin → Plugins → *ArtaOutreach* → Activate (or `wp plugin activate artaoutreach`).
Activation creates the table with dbDelta; `aor_table_version` triggers later migrations.

## REST (`/wp-json/artaoutreach/v1`)

Auth: any authenticated request whose user has `manage_options` (cookie + `X-WP-Nonce`, or an
application password). **Note:** `AQ\Auth::harden()` disables application passwords site-wide on
purpose (the DB is public, so stored password material must be inert). Machine-to-machine auth for
the Mac and the phone is therefore still an open decision; do not re-enable application passwords
without reading Auth.php.

| Method | Path | Use |
|---|---|---|
| POST | `/accounts` | Upsert by platform+handle. Body: one object or `{"accounts":[…]}` (≤500). Fields: `platform` (linkedin/facebook/instagram/x), `handle`, `profile_url`, `full_name`, `tagline`, `bio`, `photo`, `followers`, `following`, `connections`, `mutuals`, `source`, `discovered_at`. Never changes status/decisions/notes. |
| PATCH | `/accounts/{id}` | Body `{"notes":"…"}`. Notes only. |
| GET | `/queue?platform=&limit=` | Included and not yet sent, oldest decision first (phone). |
| POST | `/accounts/{id}/sent` | Phone sent the request (`at` optional ISO time). Only for included rows; idempotent. |
| POST | `/accounts/{id}/accepted` | Accepted / followed back (`at` optional). Returns `time_to_accept_s`. |

```bash
curl -u 'arash:xxxx xxxx xxxx xxxx' -H 'Content-Type: application/json' \
  -d '{"platform":"linkedin","handle":"jane-doe","full_name":"Jane Doe","mutuals":5}' \
  https://SITE/wp-json/artaoutreach/v1/accounts
```

## CSV (admin page → "CSV import / export")

- Import: header row using any of `platform, handle, profile_url, full_name, tagline, bio, photo,
  followers, following, connections, mutuals, notes` (platform + handle required). Max 2 MB / 5000
  rows. Upserts by platform + handle like ingest; blank cells never overwrite; status is never
  changed. New rows get `source=manual`. Per-row errors are shown after upload.
- Export: the current status/platform view, with status and dates (UTC). Cells starting with
  `= + - @` (or tab/CR) are prefixed with `'` against formula injection; import strips that prefix.
- Template: "Download template".
