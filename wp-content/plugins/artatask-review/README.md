# ArtaTask Review

Admin-only review queue for accounts LinkedIn, Facebook, Instagram and X suggested to Arash.
Each account is included in or excluded from the study by hand on **wp-admin → ArtaTask Review**.
The ArtaTask phone app only sends to accounts marked *included*. This plugin contains no
discovery or scraping code; it only stores what is posted to it.

## Privacy

Rows describe third parties, so table `{prefix}aq_artatask_review` is in
`AQ\Extra::PRIVATE_TABLES` (withheld from `/data`, `/schema`, `/offline`). Every route and the
admin page require `manage_options`.

## Activate

wp-admin → Plugins → *ArtaTask Review* → Activate (or `wp plugin activate artatask-review`).
Activation creates the table with dbDelta; `atr_table_version` triggers later migrations.

## REST (`/wp-json/artatask-review/v1`)

Auth: application password of an administrator (Users → Profile → Application Passwords), HTTP Basic over HTTPS.

| Method | Path | Use |
|---|---|---|
| POST | `/accounts` | Upsert by platform+handle. Body: one object or `{"accounts":[…]}` (≤500). Fields: `platform` (linkedin/facebook/instagram/x), `handle`, `profile_url`, `full_name`, `tagline`, `bio`, `photo`, `followers`, `following`, `connections`, `mutuals`, `source`, `discovered_at`. Never changes status/decisions/notes. |
| GET | `/queue?platform=&limit=` | Included and not yet sent, oldest decision first (phone). |
| POST | `/accounts/{id}/sent` | Phone sent the request (`at` optional ISO time). Only for included rows; idempotent. |
| POST | `/accounts/{id}/accepted` | Accepted / followed back (`at` optional). Returns `time_to_accept_s`. |

```bash
curl -u 'arash:xxxx xxxx xxxx xxxx' -H 'Content-Type: application/json' \
  -d '{"platform":"linkedin","handle":"jane-doe","full_name":"Jane Doe","mutuals":5}' \
  https://SITE/wp-json/artatask-review/v1/accounts
```
