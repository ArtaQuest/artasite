# Outreach (admin only)

The ArtaTask review queue and dashboard: accounts LinkedIn, Facebook, Instagram, X, GitHub and Strava suggested to
Arash, each included in or excluded from the study by hand. Included accounts are what the ArtaTask
phone app may later send a connection/follow request to.

- Page: `/artaoutreach/` (`pages/Outreach.tsx`), sidebar row "Outreach" beside ArtaCast. Not
  `/outreach/`: that slug is the legacy 301 anchor to `/sponsors/` and stays so.
- Backend: `src/Outreach.php`, routes `outreach/*` in `Rest::ROUTES`, all `'admin'`.
- Table: `aq_artaoutreach` (Schema 1.85.0), in `Extra::PRIVATE_TABLES` — never in `/data`,
  `/schema` or `/offline`. These rows describe third parties who never joined.

## Who can use it

`'admin'` = a signed-in **cookie session** whose user has `manage_options`. Everyone else gets
401 (signed out) or 403 (member). An API token is refused even when its owner is an operator
(`Rest::can` → `! Api::via_token()`), by design. The nav rows, the routes (`<AdminOnly>`) and the
page all hide for non-operators too, but that is presentation; the server is the guard.

## Endpoints (`/wp-json/aq/v1/…`)

| | | |
|---|---|---|
| GET | `outreach/accounts?platform=&status=&cursor=` | keyset page (50), status counts |
| POST | `outreach/accounts` | ingest one record or `{accounts:[…]}` ≤500; upsert by platform+handle; only sent fields refresh; never changes status/decision/source |
| POST | `outreach/decide` | `{ids[], status}` pending/included/excluded; a sent row is final |
| POST | `outreach/accounts/{id}/notes` | `{notes}` |
| POST | `outreach/accounts/{id}/sent` | `{at?}` included rows only; idempotent |
| POST | `outreach/accounts/{id}/accepted` | `{at?}` after a send; returns `time_to_accept_s` |
| GET | `outreach/queue?platform=&limit=` | included, not yet sent, oldest decision first |
| GET | `outreach/stats` | per platform counts, acceptance rate, time-to-accept median/mean |
| GET | `outreach/plan` / POST `outreach/caps` | daily caps (0–100), sent today (UTC), remaining, days to clear |
| POST | `outreach/import` | `{csv}` ≤2 MB / 5000 rows, per-row errors, new rows `source=manual` |
| GET | `outreach/export?platform=&status=` / `outreach/template` | `{filename, csv}`; cells starting `= + - @` (tab/CR) get a leading `'` |

## OPEN: machine access for the Mac and the phone

Nothing that exists fits a headless device without weakening a deliberate rule:
application passwords and password logins are disabled (`Auth::harden`, the DB is public), and
personal access tokens are refused on every `'admin'` route and drop `manage_options`.

Proposed design (not built): a dedicated `outreach` token scope that is **only** mintable by an
operator from a cookie session, **only** reaches `outreach/accounts` (POST), `outreach/queue`,
`outreach/accounts/{id}/sent|accepted`, re-checks at request time that the token's owner still has
`manage_options` (so the phone sign-in requires an admin account), is shown once and stored as
sha256 like every other token, is rate-limited, and is revocable from Settings. That needs a new
auth kind in `Rest::can` (e.g. `'admin_device'`), so it is a security decision for the operator.

## Platforms

`linkedin`, `facebook`, `instagram`, `x` (`twitter` accepted as an alias), `github` (`gh` alias), `strava`.
Daily caps default to 0 for every platform except LinkedIn (3). When a record has no `profile_url`, it
is built from the handle: `linkedin.com/in/<h>/`, `facebook.com/<h>`, `instagram.com/<h>/`, `x.com/<h>`,
`github.com/<h>`, `strava.com/athletes/<h>` (a Strava handle is the athlete id or vanity name).
"Accepted" means a connection or friend request accepted on LinkedIn / Facebook, and a follow-back on
Instagram, X, GitHub and Strava.

## Photos (zip import)

`POST outreach/import-zip` (multipart `file`, admin only) takes a `.zip` with exactly one `.csv` (same
columns as the CSV import) plus images; the `photo` cell names an image in the zip by file name (any
folder). Limits: 50 MB zip, 200 MB unpacked, 10 MB and 40 MP per image. Each image is checked by
content (JPEG, PNG or WebP only), re-encoded to a 512 px JPEG with no EXIF or other metadata, and stored as
`uploads/aq-outreach-<secret>/<random 128-bit>.jpg`. The row keeps the token `aqo:<name>.jpg`, never a
URL. The directory secret is the option `aq_outreach_photo_secret` (masked in the public DB explorer).
Photos are shown only through `GET outreach/photo/{id}` (admin only; `no-store`, `noindex`); the `<img>`
passes `?_wpnonce=`. A bad or missing photo is reported per row and the row still imports. A replaced
photo file is deleted. Plain CSV import is unchanged; `photo` there must be an http(s) URL or a token.
