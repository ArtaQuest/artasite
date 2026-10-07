# ArtaTask phone sync — main SQL, not Workers KV

ArtaTask used to keep six JSON files per member in Cloudflare Workers KV
(`TASK_SYNC`, keys `u:<wp user id>:<filename>`). That namespace is the only KV
consumer on the ArtaQuest account, and it was burning the free-tier daily cap.
Those blobs now live in the artasite MySQL (SQLite in Studio) table `aq_task_sync`,
sealed, and the phone talks to `/wp-json/aq/v1/task-sync`. This server never calls
Workers KV, D1, or a Cloudflare Worker for this path.

The Android change (ArtaQuest/artatask `AccountSync.java`) is a separate PR. This
document is the contract that PR should call.

## What is stored

| KV key suffix | API name | On the phone (today) |
|---|---|---|
| `strava_followers.json` | same | follower JSON |
| `strava_following.json` | same | following JSON |
| `mutual_connections.json` | same | mutuals JSON |
| `session_claim.json` | same | session claim JSON |
| `prefs.json` | same | prefs JSON |
| `requestStatus.json` | same | LI/IG/FB acceptance research events (append-friendly cache) |

`requestStatus.json` is sealed in `aq_task_sync` like the other blobs. On every
successful PUT the server also unpacks each event into the public research
tables `aq_arash_request_events`, `aq_arash_request_state`, and rebuilds
`aq_arash_acceptance_daily` (visible under `/data` for publication plots).
Endpoints: `GET /wp-json/aq/v1/arash/acceptance`,
`…/arash/acceptance/plot-data`, `…/arash/acceptance/events.csv` (sync-scope token).

One row per `(user_id, blob_name)`. `user_id` is the WordPress user id — the same
id the KV key put after `u:`. The ciphertext column is a libsodium secretbox
envelope. Plaintext is never written. See `AQ\TaskSync` for the byte layout.

The table is in `Extra::PRIVATE_TABLES`, so `/data`, `GET /aq/v1/schema`, and the
nightly `/offline` export do not list it. Account deletion already sweeps every
`aq_*` table with a `user_id` column that is not on `Account::RETAIN`; `aq_task_sync`
is not retained, so a purged member's rows go with the account.

## Encryption

Meeting-room E2E does not fit: those keys never reach the server, and AccountSync
needs the plaintext back. The worker-token AES-GCM used for relay screenshots does
not fit either: the phone does not hold `AQ_WORKER_TOKEN`.

The envelope matches the vault (`Vault.php`): libsodium `crypto_secretbox`, key
material only in wp-config / the environment / the vault file.

- Default key (envelope version `0x01`): `SHA-256(AUTH_KEY + "|" + AUTH_SALT + "|aq-task-sync-v1")`. `AUTH_KEY` and `AUTH_SALT` already live in `wp-config.php`, which is outside the database. Both must be at least 32 characters, same rule as the vault.
- Optional dedicated key (envelope version `0x02`): set `AQ_TASK_SYNC_KEY` in the vault, the environment, or wp-config. Writes switch to this key as soon as it is set. Reads of older rows still use the version byte, so turning the dedicated key on does not make existing blobs unreadable.
- Unsetting `AQ_TASK_SYNC_KEY` later leaves version-`0x02` rows unreadable until the phone PUTs them again. Prefer setting it before the first upload if you want a key you can rotate without rotating `AUTH_KEY` (which also invalidates WordPress cookies).

`GET` of a row the current key cannot open returns `409` `undecryptable`. The phone should PUT its local file again.

Cap: 8 MiB of JSON per blob (`TaskSync::MAX_BYTES`). That keeps the base64 ciphertext inside a typical 16MB `max_allowed_packet`.

## How artatask should call it

Base: `https://<site>/wp-json/aq/v1`

Auth is the same personal access token the rest of the developer API uses
(`Authorization: Bearer aq_…`, or `X-AQ-Token: aq_…` if a proxy strips
`Authorization`). Mint it from a signed-in browser session at Account → API tokens
and check **only** the `sync` scope. `read` / `write` / `economy` do not cover
these routes, so a notebook agent token cannot read the phone graph. A normal
cookie session can also call them (same as any other `auth: user` route); the
phone should use the bearer token, not a browser cookie.

The path does **not** include a user id. The token's owner is the row. A token
cannot read or write another member's blobs.

```
GET    /task-sync
GET    /task-sync/{name}
PUT    /task-sync/{name}
POST   /task-sync/{name}     same handler as PUT
DELETE /task-sync/{name}
```

`{name}` is one of the five filenames above. The stem without `.json` is accepted
(`strava_followers` → `strava_followers.json`). Anything else — including
`requestStatus`, LinkedIn, or Facebook — is `400` `bad_name`.

### Reads

```
GET /wp-json/aq/v1/task-sync/prefs.json
Authorization: Bearer aq_…
```

```json
{ "name": "prefs.json", "bytes": 42, "updated": 1710000000, "data": { } }
```

`data` is the JSON value (object or array). `404` `not_found` means this member
has no row. List without bodies:

```
GET /wp-json/aq/v1/task-sync
→ { "items": [ { "name", "bytes", "updated" } ], "names": [ "…" ], "max_bytes": 8388608 }
```

### Writes

The request body **is** the blob. Do not wrap it in `{ "data": … }`.

```
PUT /wp-json/aq/v1/task-sync/strava_followers.json
Authorization: Bearer aq_…
Content-Type: application/json

[ { "id": 1 } ]
```

```json
{ "ok": true, "name": "strava_followers.json", "bytes": 12, "updated": 1710000000 }
```

`POST` is the same call for a client that cannot `PUT`. `DELETE` is idempotent:
`{ "ok": true, "name": "…", "deleted": true|false }`. The worker's public route
list was not in this repo; delete is the inverse of put so the phone can drop a
blob (KV delete of `u:<userId>:<name>`).

Errors are `{ "error": "<slug>", "message": "…" }` with a non-2xx status. Slugs
the client should branch on:

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `bad_name` | not one of the five blobs |
| 400 | `bad_body` | body was not one JSON object or array |
| 400 | `too_large` | over 8 MiB |
| 400 | `rate_limited` | 600 reads or 120 writes per hour for this member. 400, not 429, so the WordPress.com edge does not replace the JSON body |
| 401 | | no session and no token (WordPress's own response) |
| 403 | `token_scope` | token is missing the `sync` scope |
| 403 | `birthday_required` | this member has not stated a date of birth; every signed-in mutation on the site is gated the same way. `GET` is not gated |
| 404 | `not_found` | valid name, no row |
| 409 | `undecryptable` / `bad_stored` | row exists but cannot be returned; PUT the local file |
| 503 | `sync_unavailable` | libsodium or the key material is missing |

A token is also inside the global developer-API limit (1000 requests/hour/token).

Sketch for `AccountSync` (not shipped in this repo):

```java
static final String[] NAMES = {
    "strava_followers.json", "strava_following.json",
    "mutual_connections.json", "session_claim.json", "prefs.json"
};

// PUT local file. Body is the file bytes. Header: Authorization: Bearer <aq_ token with sync scope>
// GET: on 200, parse JSON and read the "data" field into the local store.
// On 404, keep the local file and PUT it (first sync after cutover).
// On 409, PUT the local file.
// Do not send a user id. Do not call the worker.
```

Token mint is session-only (`POST /api/tokens` with `{ "label": "ArtaTask", "scopes": ["sync"] }`).
The raw `aq_…` value is shown once. Store it in the Android keystore.

## Cutover from TASK_SYNC

1. Deploy this artasite change (not part of this PR). The schema bump (`Schema::VERSION`)
   creates `aq_task_sync` on the next load. No KV credential is required for the table to work.
2. Ship the artatask client that calls the routes above and stops calling the worker.
   The phone already keeps these JSON files locally. On first successful auth against
   the new API, PUT each local file. That is the migration. The server does not read KV.
3. Optional, only if some install has an empty local store and the KV copy is the only
   one: an operator reads that key **once** with `wrangler kv key get` (or the dashboard)
   and PUTs the JSON to this API as that member, then deletes the KV key. Do not add a
   server code path that does this on a cache miss — that would keep spending the daily cap.
4. When installed clients no longer reference the worker, delete the `artatask-sync`
   worker and the `TASK_SYNC` namespace. There is no fallback that reads KV.

## What must never hit KV

`requestStatus` and the LinkedIn / Facebook request-check are live lookups, not sync
files. They are not in the allow-list, and this API returns `400` `bad_name` if a
client sends those names. Do not store them in `aq_task_sync`, and do not send them
to Workers KV. Point that client code at the network it is actually checking, or
leave it local — never at `TASK_SYNC`.
