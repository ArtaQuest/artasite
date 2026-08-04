# ArtaQuest — Architecture

> A free social feed of citable, reproducible work. One lean backend plugin, one React
> SPA, a normalized shardable schema. Designed to read-scale to billions of users
> and millions of published works while staying small enough for one person (or AI) to
> hold in their head.

## 1. Why this shape

The platform is **read-heavy and write-light**, like every large social product: for
each work published, millions of people read it; for each work, many heart it, discuss
it, and attach its files to posts of their own. So the architecture optimises the read
path relentlessly and keeps writes simple, append-only, and auditable.

The frontend is a static React SPA. The backend is a **thin, stateless REST API**
over **purpose-built relational tables** — never `wp_posts`/`wp_postmeta` for
high-volume entities (the EAV meta pattern is the classic WordPress scaling wall:
one logical object becomes a dozen meta rows and every read is a join-and-filter).
WordPress here is a runtime and an auth/session provider, not the data model.

```
            ┌───────────────┐   static, CDN-cached
   Browser ─┤  React SPA     │   (HTML shell + JS chunks)
            └──────┬────────┘
                   │  /wp-json/aq/v1/*   (JSON, mostly GET → edge-cacheable)
            ┌──────▼────────┐
            │  aquest        │   one plugin, 65 domain classes
            │  REST router   │
            └──────┬────────┘
                   │ $wpdb (prepared)
            ┌──────▼────────┐
            │  aq_* tables   │   normalized · indexed · shardable by id range
            └───────────────┘
```

## 2. Scaling principles (every one is enforced in code)

| Principle | Why it scales | Where |
|-----------|---------------|-------|
| **Custom normalized tables** (`aq_courses`, `aq_lessons`, …) instead of CPT+meta | One row per object, real columns, real indexes; no meta-join fan-out; integer PKs shard cleanly by id range | `src/Schema.php` |
| **Denormalized counters** on parent rows (`enroll_count`, `comment_count`, `vote_score`) | List/read endpoints never run `COUNT(*)`/aggregates — counters are read directly and bumped transactionally on write | `Db::bump()`, all writers |
| **Cursor pagination** (`WHERE id < :cursor LIMIT n`), never `OFFSET` | OFFSET scans+discards N rows → O(page·depth); keyset is O(page) at any depth | `Db::page()` |
| **Index-ordered top-N** — every ranked read sorts in the SAME direction as its index (all-`DESC`) with `LIMIT` | A mixed-direction `ORDER BY` (e.g. `votes DESC, id ASC`) can't be a single index walk → MySQL filesorts the *whole* matching set (a viral section's millions of comments, every user on a track). Uniform direction is a reverse walk + early-out. Tiebreak *direction* is cosmetic; *being index-served* is not | board read `Learn::section_thread`, `Economy::{podium,leaderboard}` — proven by `bench.sh` (`board_top`/`leaderboard`/`podium` HOTSPOT→SCALABLE) |
| **Append-only ledgers** for money/points | Immutable + auditable + full-reserve provable; balance = indexed `SUM` or a cached column; no lost-update races | `Economy` (`aq_coin_ledger`, `aq_points_ledger`) |
| **Materialized projections** of the ledgers + comment/vote tables | A read that would `SUM`/`GROUP-BY`/`COUNT` a *whole* table (leaderboard, circulating supply, the competition podium, a section's comment total) is the one thing that breaks at trillions of rows. Each is kept as a small denormalized table maintained in lockstep on write — turning O(rows) into an O(log n) top-N / O(1) read — while the source tables stay authoritative. Rebuildable + verified exactly equal to source | `aq_standing`, `aq_counters`, `aq_quester`, `aq_lessons.comment_count`; `Economy::{rebuild,verify}_*`; `tools/bench.sh` |
| **Content-addressed i18n** (`md5(source)` → translation) | Each (string × language) is translated **once, ever**, by its first visitor, then served from cache to everyone after → translation cost distributes across the audience → unlimited content/languages | `I18n` (`ay_translations`) |
| **Stateless reads** | GET endpoints are pure functions of the DB → safe to cache at the edge/CDN with short TTL + tag-based purge; horizontal API replicas need no shared session | `Rest::get()` sends `Cache-Control` |
| **Thin controllers, fat-free** | One router maps route → domain method; domains are plain classes; no framework, no DI container, no per-request bootstrap cost | `src/Rest.php` |
| **Write-through, idempotent writes** | Enroll/answer/progress are upserts keyed by `(user,object)` — safe to retry, no duplicates | `Learn` |

### How each dimension reaches "billions"

- **Users** — sessions are WP auth cookies / signed tokens (stateless); user-scoped
  rows (`enroll`, `progress`, `answers`) are keyed by `user_id` and partition by it.
  The read endpoints a logged-out crawler or casual viewer hits (course list, course
  detail, lesson, threads) are **public and CDN-cacheable**, so the long tail of
  traffic never touches PHP/DB.
- **Courses / lessons** — flat integer-keyed tables; a course page is 1 indexed row +
  1 ranged scan of its lessons. Millions of courses = a `BIGINT` PK and an index on
  `(status, created)` for listing. Shard by `course_id` range when a single DB tops out.
- **Languages (~130)** — never a column or a table per language; one
  `(hash, lang) → text` row per translated string, written lazily by demand. Adding a
  language costs nothing until someone visits in it.
- **Comments / votes (the trillion-row tier)** — written to `aq_comments` / `aq_votes`,
  never aggregated on the hot path. A section board reads a keyset page + the denormalized
  `aq_lessons.comment_count`; the competition reads the per-season `aq_quester` projection;
  "has a peer commented here?" is `total − mine > 0`, never a course-wide scan.

### Materialized projections (the scale-up invariant)

The append-only ledgers and the comment/vote tables are the **source of truth** — immutable,
auditable, publicly browsable. But a handful of reads must summarize a *whole* table, and at
trillions of rows a `SUM`/`GROUP-BY`/deep-`OFFSET` there is fatal. Each such read is backed by a
small **projection** maintained in lockstep on write:

| Read | Was (O of table) | Now (projection) |
|------|------------------|------------------|
| Points leaderboard, per-user standing | `GROUP BY` whole points ledger | `aq_standing` — top-N walk of `(track, points)` |
| Reserve / circulating supply | `SUM` whole coin ledger | `aq_counters.coins_issued` — one row |
| Competition podium (per season) | `GROUP BY` every section comment + join votes | `aq_quester` — top-N walk of `(season, course, votes)` |
| Section comment total / "others here" / course-detail badges | `COUNT(*)` / `DISTINCT` / `GROUP BY` over a section/course | `aq_lessons.comment_count` (read directly in `Courses::get` + `Learn`) |
| A comment's heart total (per heart) | `SUM(val)` over the comment's whole vote set (viral comment → millions) | atomic `±delta` bump of `aq_comments.votes` (`Data::bump`) |
| Most-enrolled courses (bursary / popular lists) | filesort over every published course | `(status, enroll_count, id)` index reverse-walk |
| `/data` explorer | `COUNT(*)` per table + deep `OFFSET` | engine row-estimate + keyset cursor |

Rules that keep a projection trustworthy: (1) it is **only ever maintained at the choke points**
— all coin/point writes funnel through `Economy::credit_coins`/`award_points`; the quester bucket
through `Economy::quester_touch` (a *scoped per-author* recompute, bounded by one author's
footprint). (2) It is **fully rebuildable** from source (`Economy::rebuild_projections` /
`rebuild_quester`, `Schema` backfill) and **verified exactly equal** to it
(`Economy::verify_projections` / `verify_quester`, `tools/verify-projections.php`). (3) Its win is
**proven by `tools/bench.sh`** — a native-`sqlite3` benchmark that seeds millions of rows and
classifies every hot query by its plan (full `SCAN`/`TEMP B-TREE` = O(rows) hotspot vs index
`SEARCH` = scalable). Baseline at 1M rows/table: reserve 36 ms, leaderboard 284 ms, podium 498 ms
→ all flat via projections. The bench also models prod-specific index shape (InnoDB appends the PK to
every secondary index — which SQLite does not — so it spells the PK columns into the dev index to keep
the plan faithful), and its three correctness siblings prove the *exactness* the speed relies on:
`verify-projections` (projection == ledger), `verify-denorm` (a comment's denormalized total stays ==
`SUM` across 180 randomized votes), `verify-podium` (the projection's ranking == the canonical aggregate,
ties and all).

### Open data — explainable & research-accessible

Radical transparency only helps if the data is *understandable*. The entire database is public
(`/data`, `Extra::db`), and a co-located **data dictionary** (`Schema::dictionary()`) documents every
table's purpose and the meaning of its non-obvious columns in plain language. It is served two ways: the
explorer annotates each table + column inline, and `GET /aq/v1/schema` returns the whole dictionary
machine-readably (table → purpose, columns, approximate row count). Because the dictionary lives next to
the `CREATE TABLE` definitions, it stays in sync on every schema change. Bulk access for analysis is the
`/offline` full-DB export; large tables page by keyset cursor, never deep `OFFSET`.

## 3. The notebook + publication model

This is the whole content model. Everything a member publishes, in every category, is a
**public Kaggle notebook that has been run**, and everything the platform asserts about it is
read back from Kaggle's public API and listed, item by item, in the open.

A submission is two things:

- the **URL of a Kaggle notebook's output page** — `https://www.kaggle.com/code/<owner>/<slug>/output`;
- the **output files the author picked** from that run.

Nothing else is uploaded. Nothing runs here: Kaggle ran the notebook, and we read its record.

### The claim, and the four facts a stranger can check

1. The notebook is **public** on Kaggle.
2. Every one of its **inputs is public** — datasets, models, notebooks.
3. The run **finished** and produced these exact files.
4. It ran with the **internet switched off** — or, if not, we say so plainly.

Each is verifiable by anyone: `kernels/pull` and `kernels/output` answer with no credential at
all, so the report stored on a work is a public assertion anybody can re-run and contradict,
not a private judgement.

What we deliberately do **not** claim. Kaggle enforces the offline condition, not us — we read
a flag on a machine we do not own, which is why the wording everywhere is "ran with the internet
switched off, on Kaggle's own record". And reproducible here means: anyone can hit Copy & Edit →
Run All on Kaggle, from public inputs, and get this. That is weaker than a byte-for-byte
re-execution and stronger than trusting one laptop. Both halves are said; neither is overclaimed.

### `src/Kernel.php` — the checklist engine

`Kernel::inspect( $owner, $slug, $selection )` returns the complete report: about twenty
deterministic checks in four groups, which are the four questions an author actually has —
*Can anyone open it? · Can anyone re-run it? · Did that run produce these files? · How repeatable
is the result?* (`Kernel::GROUPS`).

Severity is binary and honest. `BLOCK` covers three kinds of fact, and no others: one that makes the run
un-repeatable by a stranger (a private input, a needed credential, a run that ended in a crash); our own
storage and serving limits (24 files, 512 MB each, 1 GB, a type we can render); and a drawing
`Svg::clean()` cannot rebuild from an allow-list. `WARN` is everything
that is judgement — an unseeded random source, an unpinned install, a wall-clock read, an
accelerator a reader may not have, internet left on. Warnings are shown loudly and never block.
Nothing is scored, ranked, graded or judged, and every item carries the exact evidence it read:
the endpoint and its HTTP code, the metadata field, the last line of the run log, the byte count.

```
item   { id, group, severity, title, state: pass|fail|skip, detail, fix, evidence }
report { ok, blocks, pending, warnings, items[], facts{}, groups{}, checked_at }
```

`ok` is `blocks === 0 && pending === 0`. A check still waiting on the author — they have not picked
their files yet — is **pending**, never a failure: conflating the two greets a member who has just
pasted a perfectly good URL with a list of "problems" that are neither. `Kernel::blocking_reason()`
renders the one-line refusal, real failures ahead of pending ones.

The selection is bounded: at most 24 files, 512 MB per file, 1 GB per submission. `Kernel::TYPES`
is the extension → (media class, mime) allow-list of what the Library can serve, and `HERO_ORDER`
decides which of a work's files fronts its card.

### `src/Kaggle.php` — the read client

A dependency-free HTTP client over Kaggle's public API. The surface was probed live, not taken
from the docs, and the class docblock is the record of what actually answers:

| Read | What it gives us |
|------|------------------|
| `GET /kernels/pull` | privacy flag, internet/accelerator flags, the sha256-pinned image, all four input-source lists, and `blob.source` (the notebook itself) |
| `GET /kernels/output` | `files[{fileName,url}]` + `nextPageToken` + the full run log |
| `GET /datasets/view/{ref}` | 200 public · 403 private-or-gone |
| `GET /models/{ref}/get` | 200 with an explicit `isPrivate` |

`kernels/status`, `kernels/list` and `competitions/list` are **401 for us in every auth mode** — run
health is inferred from the output log instead, and those three must not be reintroduced.

Three traps, each of which silently produces a wrong answer if ignored:

1. A private **or** deleted kernel/dataset answers **403, never 404** — and both mean the same thing
   to a reader, so both are reported as "a reader cannot open this".
2. Output files carry **no size**, and `HEAD` on a signed `kaggleusercontent` URL is 404. The only
   working probe is a one-byte ranged `GET` (206 + `Content-Range: bytes 0-0/N`), which doubles as
   the "does it actually download" check so the two share one network pass.
3. `metadata.lastRunTime` is not a run timestamp — it changes on every call for an untouched
   kernel. Never stored, never displayed.

Signed output URLs are minted per request and expire, so they are used immediately (to size, and
to mirror at publish time) and are never stored or handed to a browser. A listing is capped at
40 pages × 200 files and reported as `truncated` rather than silently trimmed.

### The substrate — `aq_notebooks` and the stored report

One row per work, self-installed under `aq_notebook_table_version` (separate from
`Schema::VERSION`). The kernel it points at and the verdict it earned live on that row:

| Column | Holds |
|--------|-------|
| `kg_owner`, `kg_slug` | the parsed kernel identity — indexed as `KEY kernel` |
| `kg_url` | the canonical `kaggle.com/code/<owner>/<slug>` link back to the source of record |
| `kg_facts` | the `facts` block: title, author, version, image, machine shape, the internet/GPU/TPU flags, every declared input source, run seconds, file listing, sizes |
| `checks` | the report **verbatim** — the array the engine returned |
| `selection` | the filenames the author chose to publish |
| `checked_at` | when the checklist last ran against Kaggle |

The report is stored as it was produced and rendered unchanged in public, so there is no second,
friendlier version of the verdict anywhere.

### The Library — `aq_library` + `aq_post_media`

The point of the reset: a reproducible artifact stops being locked inside the work that made it
and becomes a citable object any member can attach to a post.

- **`aq_library`** — one row per **published output file**: `nb_id` (the provenance that proves it
  came out of a run that passed the checklist), `author_id`, `name`/`label`, media `class`, `mime`,
  `bytes`, `sha256`, the `cdn_key`, and a `uses` counter. Unique on `(nb_id, name_key)`, where
  `name_key` is `sha1(name)` — a Kaggle output path routinely exceeds what an index may cover, and
  the MySQL-only prefix form `name(180)` makes dbDelta emit no table at all under Studio's SQLite.
  The column is `cdn_key` and not `stored` for the same class of reason: STORED is reserved by that
  SQLite layer's MySQL parser. Rows are created **only** by the publish path, never by an upload,
  and un-listed by `Kernel::prune()` when a file leaves the selection (deleted, not orphaned — the
  unique key makes a second de-selection of the same name collide with the first orphan).
  Removing the work removes its listings too, via `Kernel::unlist()` (= `prune` with an empty
  selection) — mirroring happens at publish REQUEST, so a work removed before or after approval has
  already put rows on the shelf, and `GET /library` hiding them (it joins on a PUBLISHED work) made
  the accumulation invisible rather than harmless. Two things never go: a row already attached to a
  post, because a removal must not blank an attachment in someone's timeline; and the CDN object
  itself, because the key is the `sha256` and another work may be serving the identical bytes.
- **`aq_post_media`** — which Library items ride on which post. A member may attach **any**
  published item, not only their own; that sharing is what the Library exists for, so ownership is
  deliberately not checked here. Provenance travels with the item through `nb_id`.

The bytes are mirrored to our own CDN (Cloudflare R2, via `Media`; `Media::url( cdn_key )` resolves
the public address) at **publication-request** time, not at confirm time — the confirm page's whole
purpose is that the author reviews the WORKING deliverable before an irreversible act, and it cannot
do that from a Kaggle URL that expires in minutes. Mirroring at all is what stops a citation rotting:
a Kaggle kernel is owner-editable and owner-deletable, and a citation that resolves only while its
author leaves it alone is not a citation.

**The CDN origin is load-bearing in two directions, and both are easy to break.**

1. *Security.* Being a DIFFERENT origin is what makes a member-authored `.html` (a published 2D/3D
   game) safe to frame and a published `.svg` safe to serve. `Media::put_public()` therefore refuses
   to fall back to this origin's uploads directory for script-capable types — publication fails
   loudly rather than turning an artifact into stored XSS.
2. *Reachability.* Because it is cross-origin it must be named in the **CSP**, or the browser
   refuses it. `frame-src`, `media-src` and `connect-src` take the origin from
   `\AQ\Media::cdn_base()` in `functions.php` — never a hardcoded bucket id, since the bucket is a
   rotatable Vault secret and `cdn_base()` falls back to this origin when R2 is unset. This is
   invisible in development: **Vite's dev server sends no CSP at all**, so every media renderer
   works locally and is dead on production. PDFs render in an `<iframe>` rather than an `<object>`
   precisely so `object-src 'none'` can stay.

### Two media stores, and why they never merge

There are exactly two, and confusing them is how a member ends up with a track visible in one place
and not the other.

| | The Library (`/library`) | My Library (`/my-library`) |
|-|--------------------------|----------------------------|
| Where | `aq_library` + the R2 CDN | **IndexedDB on the device** (`lib/media-store.ts`) |
| Whose | everyone's, published | this member's, private, never uploaded |
| Offline | no — it is a `/wp-json` read | yes, entirely |
| Owner | `Kernel` (PHP) | `media-store` + `components/player.tsx` |

The bridge is one function: `saveFromUrl()` fetches the CDN copy and hands it to `importFiles()`, so
a saved item inherits the quota preflight, decode probe, tags, cover art and `requestPersistence()`
instead of a second, worse copy of each. Eligibility follows what the **store** can play
(`kindOf`: music, video, PDF), not the Library's media `class` — `doc` also covers md/txt/html,
which it cannot, so the button tests the extension.

The service worker deliberately **never caches `/wp-json`**: personal data does not belong in a
shared HTTP cache, and the app's own offline layer owns it. Consequently the Library is honestly
unavailable offline and says so, pointing at My Library. Navigations are network-first with a cached
shell, so every route still boots with no connection.

Background playback is not a feature of either store: `PlayerProvider` is mounted at the app root so
the `<audio>` element outlives navigation, and the player publishes `MediaSession` metadata and
handlers for the lock screen. One coupling is easy to miss — `fileUrl()` keeps an LRU of six object
URLs, so the player **must** `pinMedia()` the current and next track. Unpinned, opening six other
items revokes the URL the audio element is still reading from; Chrome survives on its buffer,
Safari streams a blob lazily and stops.

### The JupyterBook page — `lib/ipynb.ts` + `pages/NotebookBook.tsx`

Every work has one, at `/nb/<id>/<slug>/book`, generated in the browser from the submitted `.ipynb`
and rendered by `ReadMode` — which **is** ArtaReader. That is not a lookalike: the member gets the
reader's typography controls, contents panel, remembered reading position, themes, fullscreen and
narration, over the notebook itself. A literal `jupyter-book` static build was rejected for exactly
this reason: it would be an opaque iframe, and nothing of ArtaReader could live inside one.

**What it can honestly contain, established by probing Kaggle rather than reading their docs.**
`kernels/pull` returns the source with `outputs: []` on every cell, and `kernels/output` lists only
the files the notebook wrote — **never `__results__.html`**. Kaggle's own executed render is not
retrievable at any endpoint we have. So the book is *the notebook as its author wrote it*, and the
artifacts the run actually produced go in `ReadMode`'s figures panel. Those files ARE the result;
presenting a pulled, output-less source as "the run" would show something no run produced.

Two rules keep it safe, because `ReadMode` injects `body` with `dangerouslySetInnerHTML`
(deliberately — replacing text nodes is what lets ArtaTTS follow sentences) and a notebook is
member-authored:

1. **Prose** goes through `renderRich()`, which escapes every run of text before emitting any tag.
   Raw HTML in a markdown cell renders as visible literal text — the safe failure.
2. **Code never goes through it.** `renderRich` recognises only three-backtick fences and drops the
   language, so a cell containing a fence of its own — a notebook that prints markdown, which is not
   exotic — would break out and be re-parsed as prose. Code blocks are escaped and wrapped in
   `ipynb.ts` instead, which also keeps the language label.

`renderRich` emits headings without ids (it was written for discussion bodies, which have no
contents panel), so `withHeadingIds()` adds them and `ReadMode`'s panel reads them back out of that
same HTML — the two cannot drift the way a separately-derived TOC would. A notebook whose author
wrote no headings at all gets `## Step N` scaffolding, and one that wrote any is left alone.

The URL matters: `nb` is also the **Norwegian locale code**, so `I18n::strip_prefix()` treats every
`/nb/…` request as Norwegian and a reclaim in `aq-app.php` puts it back. Both that reclaim and the
SEO lookup had to learn the `/book` suffix, or the page 404s to crawlers while working in the SPA.
The book canonicals to the work page, so they are not duplicate content.

### The publish path

1. **Paste** — `Kaggle::parse_url()` reduces any shape of kernel link to `owner/slug`, and every
   check that does not depend on a selection runs immediately. A private dataset is reported the
   moment the URL is pasted, not after the author has done the work of choosing files.
2. **Pick** — the author selects output files; the checklist re-runs; report, facts and selection
   are stored on the row.
3. **Request** — publication is **requested, never taken**. Every blocking check must be clear.
   A single-use random secret is minted at send time, goes into a link emailed to the author's own
   registered address and **nowhere else**; the database (which is public) holds only
   `sha256(secret|source-signature)`, so nothing running on the server can reconstruct a valid link.
   A single-use nonce is minted with it. An API token or an AI agent can request — never confirm.
4. **Confirm** — `GET` on the link shows a review page, so a mail scanner prefetching it cannot
   publish; only the explicit `POST` acts, and it carries the author's device **passkey** signature
   over `source-signature : nonce`. The private key never exists on the server, so no one with
   server or source access — us included — can forge that consent, and the signature lands in the
   public ledger to be re-verified forever.
5. **Publish** — the confirmation is appended to the append-only ledger **first**; a database
   trigger refuses any transition of a row into `published` that is not preceded by that sig-bound
   proof, from any client at all (plugin, wp-cli, raw SQL, an agent on the box). Whether that layer
   is actually installed is recorded publicly in the `aq_publish_guard` option (`triggers` /
   `unavailable` — managed MySQL can refuse trigger DDL, and local SQLite has no `SHA1()`), because
   an absent guard must be known-absent, never imagined-present; the signature and the sweep carry
   the guarantee on their own. Then the row flips, the selected files are fetched from Kaggle and
   mirrored into the Library, and the permanent DOI is minted — member-facing as `/d/n<id>`
   (`Doi::nb_link`); the archive provider never renders.
6. **Sweep** — `integrity_sweep()` demotes and alerts on any published row missing its author
   proof, so even a direct SQL flip is reverted rather than trusted.

The kernel is the **provenance**; the DOI is the **citation of record**. A kernel can be edited or
deleted by the person who owns it. A DOI cannot.

Submitting, checking and publishing are all free. The Foundation runs on donations.

### One dependency that is not code

The plugin still has **no third-party code dependencies** — no framework, no SDK, no vendor tree,
nothing to audit but our own files. But publication now hard-depends on a third-party **service**:
every fact in the checklist is read from Kaggle, and the published bytes come out of a Kaggle run.
That is a deliberate trade — a claim a stranger can check on a machine neither of us owns is worth
more than one only we can check — and it belongs in the open rather than buried in a client class.

So the failure mode is designed, not discovered. When Kaggle is unreachable — a network error, a
timeout, a 5xx, a credential the Vault has not got — a check has **no answer, and a check with no
answer fails**. It never passes on assumption, and it never substitutes an older pass for a missing
answer. Publication therefore **blocks**: the work stays a draft, the author sees the HTTP code that
was actually received as that item's evidence, and they re-run the checklist when the service is
back. Nothing is faked — no DOI is minted, no Library row is written, no fact is invented from an
unverified claim. Every call is bounded by an explicit timeout (60 s metadata, 45 s size probe,
300 s a file fetch), so an outage degrades into a blocked publication rather than a hung request.

Reading is unaffected either way: published works, their Library files and the feed are served from
our own tables and CDN, so a Kaggle outage can only ever delay a **new** publication.

## 4. Data model (`aq_*` tables)

Created/migrated idempotently by `Schema::install()` (versioned via the
`aq_schema_version` option; bump `Schema::VERSION` to migrate).

| Table | Purpose | Hot indexes |
|-------|---------|-------------|
| `aq_notebooks` | one row per work: the kernel it points at (`kg_owner`, `kg_slug`, `kg_url`), the stored checklist report (`checks`, `kg_facts`, `selection`, `checked_at`), publication state, `hearts`, `doi` | `(kg_owner, kg_slug)`, `(status, kind, id)`, `(status, hearts, id)`, `(author_id, id)`, `slug` |
| `aq_posts` | the feed: a short text post, optionally carrying a published work (`nb_id`) or a repost | `(id)`, `(author_id, id)`, `(hearts, id)`, `nb_id` |
| `aq_library` | one row per published output file — `nb_id` provenance, media `class`, `mime`, `bytes`, `sha256`, `stored` CDN key, `uses` | `(nb_id, name)` unique, `(class, id)`, `(author_id, id)` |
| `aq_post_media` | which Library items ride on which post | `(post_id, lib_id)` unique, `(post_id, pos)`, `lib_id` |
| `aq_courses` | one row per course; denormalized `lesson_count`, `enroll_count`, `rating_*`, `views`, `rank_score`, `author_id` | `(status, id)`, `(status, rank_score, id)`, `(status, enroll_count, id)`, `slug`, `author_id` |
| `aq_lessons` | one row per lesson; `course_id`, `idx`, video fields, `transcript` (JSON), `duration`, denormalized `comment_count` | `(course_id, idx)` |
| `aq_markers` | interactive in-video questions; `lesson_id`, `t` (seconds), `prompt`, `answers` (JSON) | `(lesson_id, t)` |
| `aq_enroll` | enrollment + course progress; PK `(user_id, course_id)`; `pct`, `status` | `course_id` |
| `aq_progress` | per-lesson completion; PK `(user_id, lesson_id)` | `user_id` |
| `aq_answers` | per-marker responses; PK `(user_id, marker_id)`; `correct` | `user_id` |
| `aq_coin_ledger` | full-reserve money ledger (1 ₳ = 1 mg gold); append-only `delta`, `reason`, `ref` | `(user_id, id)` |
| `aq_points_ledger` | standing/points (lifetime, never spent); append-only; `track` | `(user_id, id)`, `(track, id)` |
| `aq_standing` | projection: lifetime points per `(track, user_id)` + an `all` total row | `(track, user_id)`, `(track, points)`, `(user_id)` |
| `aq_counters` | projection: global scalars (`coins_issued` = Σ coin deltas) | `(name)` |
| `aq_quester` | projection: per-season competition standing `(season_key, course_id, user_id) → votes, comments` | `(season_key, course_id, user_id)`, `(season_key, course_id, votes, comments)` |
| `aq_threads` | global discussion threads; `author_id`, `lang`, denormalized `comment_count`, `vote_score` | `(status, id)`, `author_id` |
| `aq_comments` | thread comments; `thread_id`, `author_id`, `lang`, `vote_score` | `(thread_id, id)` |
| `aq_votes` | one vote per (user, target); PK `(user_id, target_type, target_id)` | `(target_type, target_id)` |
| `aq_follows` | social graph; PK `(follower_id, target_id)` | `target_id` |
| `ay_translations` | content-addressed i18n cache (**kept** from old build: 88k rows) | `(hash, lang)` |
| `aq_i18n_seo` | per URL+lang translated SEO bundle (**kept**) | `(url_hash, lang)` |

All money/points entities are **append-only ledgers** — no in-place balance mutation,
so they are race-free, auditable, and the full-reserve invariant (`SUM(delta) == backing`)
is checkable at any time.

The notebook + Library tables self-install on their own `aq_notebook_table_version`, separate from
`Schema::VERSION`. The course-era tables (`aq_courses` … `aq_answers`, `aq_quester`) are retained
from the retired legacy platform and have stood empty since the 2026-07-13 reset; their seeders
were removed and must not be re-added.

## 5. Backend layout (`wp-content/plugins/aquest/`)

One self-contained plugin, **no third-party code dependencies** — no framework, no SDK, no vendor
tree (it replaced the 4,071-file MasterStudy LMS bundle + WooCommerce). Publication does depend on
a third-party **service**; see §3, "One dependency that is not code".

```
aquest/
  aquest.php        Plugin bootstrap: constants, autoloader, activation→Schema, rest_api_init→Rest
  src/              65 domain classes; the publication path is these:
    Schema.php      Versioned table install/migrate (dbDelta)
    Db.php          Query helpers: page() cursor, bump() counter, one()/all()/json columns
    Rest.php        Route table → domain methods; auth/permission; JSON + cache headers
    Auth.php        Passwordless: email one-time code + Google; stateless sessions
    Notebook.php    The works substrate: submission, the stored report, the publish path, the feed
    Kernel.php      The reproducibility checklist — the whole publication gate
    Kaggle.php      The read client: pull / output / input-source privacy / ranged size probe
    Media.php       CDN (Cloudflare R2): the mirror behind every Library file
    Passkey.php     WebAuthn enrol + assertion verify — the author's publishing signature
    Mailer.php      Transactional mail, incl. the author's single-use confirm link
    Doi.php         /d/n<id> short links; the archive provider never renders
    Economy.php     Coin + points ledgers, balances, leaderboard
    Social.php      Global threads/comments/votes/follows + per-viewer translation hooks
    I18n.php        config / resolve / translate-proxy / save / SEO (content-addressed)
    Funds.php       Donations, foundation ledger, public financial transparency
  README.md
```

Every route lives in one place (`Rest::ROUTES`) so the whole API surface is one
readable table — the single most important property for "easy for any human or AI
to navigate."

## 6. API conventions

- Base: `/wp-json/aq/v1/`.
- **GET** = public, idempotent, cacheable (`Cache-Control: public, max-age=…, s-maxage=…`).
- **POST** = mutation, requires a session (cookie + nonce, or bearer token), rate-limited.
- Lists return `{ items: [...], next: <cursor|null> }` — always keyset, never page numbers.
- Errors: `{ error: "code", message: "human" }` + correct HTTP status.
- All input sanitized, all output escaped, all SQL via `$wpdb->prepare()`.

## 7. Frontend (`artaquest-web/`)

Vite + React + TypeScript SPA. `src/lib/api.ts` is the client NEW code talks to the
backend through — one typed module mirroring `Rest::ROUTES`. It is not yet the only
one, and the docs used to claim it was: `src/lib/wp.ts` is a compatibility bridge left
from the MasterStudy cutover (174 exports, imported by 78 files, calling the same
routes), and `auth.ts`, `i18n.ts` and `verify.ts` each hold their own fetch. Do not add
to that set — the goal is still one client, and saying so falsely does not get us there. Pages are presentational and
read from the client. The i18n engine (`src/lib/i18n.ts`) gates first paint so no
untranslated component is ever shown, and persists new translations back to the cache.

## 8. Local dev (WordPress Studio / SQLite)

- `studio site start` — run WP (PHP-WASM + SQLite).
- `studio wp eval '…'` — run PHP (the `wp db query` CLI is broken under WASM; use `$wpdb`).
- Frontend: `cd artaquest-web && npm run dev` (Vite proxies `/wp-json` → Studio).
- Schema installs on plugin activation and on `Schema::VERSION` bump.

Production is WordPress.com Atomic (MySQL) — the same `$wpdb` code runs unchanged; the
custom tables, counters, and keyset pagination are exactly what a managed MySQL scales
best on.
