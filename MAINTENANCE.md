# ArtaQuest — Operations Runbook (2026-07-15)

One page for everything recurring. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · API: [wp-content/plugins/aquest/src/Rest.php](wp-content/plugins/aquest/src/Rest.php) · Coordination: tools/ticket-agent/COORDINATION.md.

## Deploy

**`git push` to `main`. That is the entire procedure** — see [DEPLOYING.md](DEPLOYING.md).

Nothing deploys from a laptop, and the instructions that used to be here could not have worked:
production runs `opcache.validate_timestamps = 0` with `opcache.restrict_api` pointed outside our
tree, so PHP copied in over SSH **never executes** — the copy reports success while the site keeps
serving the old bytecode. `touch`-ing the files does not help; only WordPress.com's own pipeline
invalidates that cache. The local deploy script is deleted and `aq-deploy` refuses with exit 69.

The SPA is not committed either: `wp-content/themes/artaquest-theme/app/` is build output, gitignored,
and built in CI. Committing it makes every working copy fight over the same manifest.

## The notebook pipeline
- Daemon: `tools/ticket-agent/relay-install.sh notebook install|reload|status|logs`. Logs: `~/Library/Logs/artaquest-notebook-relay.*`.
- **Scale workers**: claims are atomic + fenced — run extra workers anytime: `cd tools/ticket-agent && nohup node notebook-relay.mjs > ~/Library/Logs/artaquest-notebook-relay-N.log 2>&1 &` (a second permanent worker is installed as `org.artaquest.notebook-relay2`).
- Executor venv: `~/.artaquest-dev/nb-venv` (jupyter + numpy/pandas/matplotlib/pillow; sitecustomize blocks non-loopback sockets when `AQ_OFFLINE=1`).
- Pipeline state: `ssh artaquest 'cd ~/htdocs && wp db query "SELECT id,nb_id,type,state,iters_done,score FROM wp_aq_nb_runs ORDER BY id DESC LIMIT 10"'`.
- Seed demos: `tools/seed-notebooks.php <dir> <iters>` (filename = kind). There is no publish-from-CLI step: publication is requested by the author and confirmed from their own inbox, and nothing else can mint it.
- Fees: publishing free; challenge entry fees → pools, winner-takes-all at full moons (settlement: lazy + hourly cron `aq_nb_settle`).

## In-browser runner — the Lab, INSIDE the SPA (2026-07-16; JupyterLite scrapped 2026-07-15)
- The one notebook editor is `artaquest-web/src/pages/Lab.tsx` at **/lab?src=<raw ipynb>** (no src =
  scratch pad) — SPA-consistent: shell + BackgroundSwitcher (the ArtaContrast changer), MarkdownLite +
  KaTeX, nbview `OutputView` (live mode opens HTML/JS sandboxes immediately), ui kit, i18n. Kernel =
  `lib/pykernel.ts` (Pyodide module worker), highlighting = `lib/highlight.ts`. Section tracker at
  ≥xl. `tools/lite-run.html` → `/wp-content/lite/run.html` is now only a REDIRECT stub to /lab.
- CSP (theme functions.php): the Lab needs `worker-src 'self' blob:` + `'wasm-unsafe-eval'` +
  `cdn.jsdelivr.net` (script/connect fallback) — do not remove them or the kernel dies.
- Python dist: still the self-hosted `/wp-content/lite/static/pyodide/` (Pyodide 314.0.1, 332 wheels
  incl. numpy/pandas/matplotlib/pillow) — keep that directory; jsDelivr `v314.0.1/full/` is the
  automatic fallback (used in local dev, where the self-hosted path 404s).
- The old JupyterLite tree was PRUNED from prod 2026-07-16 — `lite/` now holds ONLY `run.html` +
  `static/pyodide/`. The removed app files sit reversibly in `artaquest:~/lite-retired-jupyterlite-20260716/`
  (791 files, 68M); rebuild inputs also remain in `~/.artaquest-dev/lite-build`. run.html unregisters
  the old app's service workers.
- ArtaContrast: the Lab reads the LIVE engine directly (no port — it's in the SPA): matplotlib
  rcParams are themed from the computed `--color-ink/-2/--color-line` tokens and re-synced on every
  `aq:contrast` event, with transparent figure/axes; figures capture as WebP+alpha (PNG fallback) so
  they blend with the canvas; authors' explicit facecolors win. `IPython.display` is a built-in shim
  (HTML/Image/Markdown/Math/display) — the real wheel never loads.
- Tests: `scratchpad e2e-lab.mjs` — real-Chrome scenarios against /lab (React textareas need the
  NATIVE value setter before dispatching input); the kernel bootstrap in lib/pykernel.ts is
  CPython-testable (stub `aq_bridge` + `pyodide.code.eval_code_async`).

## Backups & recovery
- Pre-reset snapshot: `~/.artaquest-dev/backups/prod-full-pre-purge-2026-07-13.sql.gz` (the old platform). Take new ones: `ssh artaquest 'cd ~/htdocs && wp db export - | gzip' > backup.sql.gz`.
- DOIs are permanent — removal only unlists.

## Hard platform rules (enforced in code — do not soften)
- Reproducibility: the gate is `Kernel::inspect()` — ~20 deterministic checks read back from Kaggle's public API. We execute nothing and enforce no offline condition; Kaggle does both, and we read and report its record. `Notebook::blob_guard` still rejects opaque payloads at save + dev-update.
- Ledgers append-only (Watchdog alarms on rewrites; `rebaseline()` after intentional bulk ops).
- No astrology surfaces; no radial charts; gold+blue only (`255−gold`); no third accent.

## GitHub
- Public repo: `github.com/ArtaQuest/artasite` — the only route to production. Never commit secrets; the Vault is the only secret store.
