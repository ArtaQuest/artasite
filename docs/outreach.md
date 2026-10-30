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

## ArtaSearch (the Search tab)

An alumni directory inside Outreach: one row per alumnus (`aq_alumni`, upsert key = lower-cased
full name + department, with the graduation year) with the public LinkedIn, Instagram, Facebook, ResearchGate, YouTube,
GitHub and X profiles the ArtaSearch scan confirmed as the same person. Admin only, and the table
is in `Extra::PRIVATE_TABLES`.

- Reads: `GET outreach/alumni`, `outreach/alumni/facets`, `outreach/alumni/export` ('admin').
  Order (1.25.6): youngest class first, then department, then name — the same order the scan works
  in. The list's `cursor` is an opaque offset (0 = first page); the year facet is listed newest first.
- Scope (2026-10-23): the scan now works from the operator's final roster, limited to Electrical and
  Electronics Engineering, Computer Engineering, Mechanical Engineering, Architecture, Molecular
  Biology and Genetics, Mathematics and Chemistry, youngest class (2030) to oldest. Rows from the
  earlier scan stay until their year is re-synced (the scan box holds prune while the new run fills in).
- Confident data only (operator 2026-10-23, 1.25.7): `emails` holds at most 5 addresses, each with
  its source — the alumni roster's own address (source `roster`) or an address the scan rated HIGH
  (it carries the person's name and was published on the matched person's own page: a kept profile,
  the kept GitHub account, or their own full-name website), with that https page as the source.
  Medium/low e-mails and every unconfirmed X candidate stay on the scan box; profiles are
  confirmed matches only (accounts held for re-check are not sent, and the server drops them too).
  `public_email` remains for older rows.
- `POST outreach/alumni/to-queue {id, platforms[]}` copies profiles into the Review queue as pending.
- `POST outreach/alumni/ingest {alumni:[…]}` is the scan box's only way in. It requires the dedicated
  secret `BOT_ARTASEARCH_TOKEN` in the `X-AQ-Alumni-Token` header (≥32 chars, compared with
  hash_equals), HTTPS, at most 60 requests an hour per IP, a 2 MB body and 500 rows. It returns 404
  until the secret is set. Set the secret in wp-admin → AQ Security (vault), or as an env var or
  wp-config constant.
- Full replace per year: a request may carry `prune:{year, keep:[{full_name, department}]}` (alone or after the year's batches); rows of that year whose key is not in `keep` are deleted. Refused if it would delete more than max(10, 10%) of the year's rows.
- Photos: a GitHub avatar (`github.com/<login>.png`) or the platform's logo. Nothing is scraped.

### Who can open Outreach

Every `outreach/*` route (ArtaSearch included, except the token-checked ingest) uses the
`'outreach'` auth level: a cookie session (API tokens are refused) whose user has manage_options,
**or** whose slug is in `Outreach::EXTRA_SLUGS` (`artafather`, the founder's own account). This
grants Outreach only. ArtaCast and every other admin surface still require manage_options.

## ArtaSearch: LinkedIn Follow (1.25.23–1.25.24)

LinkedIn has its own Follow button on each ArtaSearch row and detail panel, separate from the shared Follow.
Neither button automates anything: Follow opens the profile URL(s) in the admin's own browser and records the
click in user meta. The shared Follow now opens every matched platform EXCEPT LinkedIn (`aq_alumni_follows`).
The LinkedIn Follow opens only the LinkedIn profile and records it in `aq_alumni_li_follows`, counted against a
per-admin rolling 7-day quota (`aq_alumni_li_follow_log`; unfollow does not refund). The server refuses a new
LinkedIn follow past the cap with 429 `li_weekly_cap`. The cap is the site option `aq_alumni_li_weekly_cap`
(default 80, 0..500, filter of the same name), readable/settable via GET/POST `outreach/alumni/linkedin-quota`.
