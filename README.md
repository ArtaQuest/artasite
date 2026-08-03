<div align="center">

# ArtaQuest

**A free social feed of citable, reproducible work — built to scale to billions.**

Every submission is a public Kaggle notebook that has been run. Paste the URL of its
output page, pick the files to publish, read the reproducibility checklist, then confirm
from your own inbox — your click is the only thing that publishes the work and mints its
permanent DOI. Published files land in the Library, where any member can attach them to
a post · global discussions · donations with public financial transparency ·
a radically public database · ~133-language translation mesh.

The claim is four facts, each checkable by a stranger: the notebook is **public** on
Kaggle, every one of its **inputs is public**, the run **finished** and produced these
exact files, and it ran with the **internet switched off** — or, if it did not, we say
so plainly. Kaggle's public API answers those questions with no credential at all, so
the checklist is not our private judgement: anyone can re-run it and contradict us.

</div>

---

> **Deploying:** push to `main`. That is the whole procedure — see [DEPLOYING.md](DEPLOYING.md).

## Why it's built this way

ArtaQuest is **read-heavy and write-light** like every large social product,
so the whole architecture optimises the read path and keeps writes simple and auditable.
The frontend is a static React SPA; the backend is a thin, stateless REST API over
**purpose-built relational tables** — never WordPress's `wp_posts`/`wp_postmeta` for
high-volume data. One small plugin replaces a 4,071-file off-the-shelf LMS.

Full rationale: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Repository map

```
artaquest-web/                 React + TypeScript SPA (Vite)
  src/lib/api.ts               ← the frontend↔backend contract, typed (new code uses this)
  src/pages/                   presentational pages
wp-content/plugins/aquest/     the whole backend — one dependency-free plugin
  src/Rest.php                 ← the entire API surface in one route table
  src/Schema.php               every table + index
  src/Notebook.php             the one content model — every submission is a row here
  src/Kernel.php               the reproducibility checklist — key one of the gate
  src/Kaggle.php               the read client the checklist runs on
  src/{Social,Economy,Auth,I18n,…}.php   one domain class each (65)
wp-content/themes/artaquest-theme/   serves the SPA shell + SEO; app/ = the built SPA
ARCHITECTURE.md                the scaling design
CUTOVER.md                     historical: the old LMS/Woo stack retirement (complete)
```

**Start at `src/Rest.php`** — every endpoint, its method, auth level, and handler is one
readable table. Then `ARCHITECTURE.md` for the why.

## Scaling principles (enforced in code)

- **Normalized custom tables** with real indexes — integer PKs shard by id range.
- **Denormalized counters** so list/read endpoints never aggregate.
- **Keyset (cursor) pagination** everywhere — O(page) at any depth, never OFFSET.
- **Append-only ledgers** for money/points — race-free, auditable, full-reserve provable.
- **Content-addressed i18n** — each string×language translated once, ever, by its first
  visitor, then cached for everyone → translation cost distributes across the audience.
- **Stateless, CDN-cacheable GETs** — the long tail of read traffic never touches the DB.

## Local development

Runs on [WordPress Studio](https://developer.wordpress.com/studio/) (PHP-WASM + SQLite).

```bash
studio site start --skip-browser          # run WordPress
studio wp plugin activate aquest           # installs the schema
cd artaquest-web && npm install && npm run dev   # SPA at :5173, proxies /wp-json
```

API check:
```bash
curl -s http://localhost:PORT/wp-json/aq/v1/notebooks | jq
```

See [STUDIO.md](STUDIO.md) for the Studio/WP-CLI specifics (always `studio wp …`).

## License

[GNU AGPL-3.0-or-later](LICENSE). © ArtaQuest Foundation.

The Affero clause is deliberate: anyone who runs a modified copy as a network
service must publish their source too — the same radical transparency the
platform itself is built on.
