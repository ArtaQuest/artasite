# Deploying

**`git push` to `main` is the entire procedure.** There is nothing to run locally, and no machine
has to be awake.

```
push to main  →  CI verifies  →  artifact `wpcom`  →  WordPress.com deploys  →  artaquest.com
```

## What happens on a push

| Branch | Workflow | Deploys |
|--------|----------|---------|
| `main` | `.github/workflows/main.yml` | **yes** — WordPress.com pulls the `wpcom` artifact |
| any other branch | `.github/workflows/branches.yml` | no |

The checks are identical, so *green on your branch* predicts *green on main*.

**Do not merge these two workflows.** WordPress.com's deployment binds to `main.yml` and is fussy
about its shape: widening its trigger to every branch, and making the artifact step conditional,
made every deployment fail with `Error` before it even started. Branch verification is a separate
file for exactly that reason.

**Mode must be Advanced.** A *Simple* deployment downloads the repository itself — the log says
`Downloading repository for simple deployment` — which puts `analysis/`, `artaquest-web/`, `tools/`
and every markdown file into the live web root, and deploys a theme with no SPA bundle. That
happened once and had to be cleaned off production by hand.

### The gates, and why each exists

| Gate | Why |
|------|-----|
| **hygiene** | No keys, and no machine attribution. GitHub counts a `Co-authored-by:` trailer as a *contributor*, so one trailer lists a tool beside the people who built this. Runs first — a grep settles in a second what a build would take minutes to reject. |
| **php -l** | The plugin and theme never reach a runtime in CI, so syntax is all that can be asserted. |
| **typecheck** | The whole tree must compile. The one signal that is always meaningful. |
| **lint** | Only what the push *changed*. A full run reports ~35 pre-existing errors, and a gate that can never go green means nothing ever deploys. |
| **build** | Code that compiles can still fail to bundle — and this exact output is what ships. |
| **hollow-build check** | A zero exit from the bundler is not proof the output is usable. The deploy replaces the live bundle, so a hollow build would take the site down. |

## Why the built SPA is not in the repository

`wp-content/themes/artaquest-theme/app/` (~52MB) is generated output and is gitignored. Committing
it makes every working copy fight over the same manifest.

That is also why WordPress.com must run in **Advanced** mode: *Simple* copies the repository
verbatim, so it would deploy a theme with **no bundle** — and if the deploy prunes files absent from
the repository, it would delete the live one. Advanced builds the SPA in CI first, so the artifact is
complete.

## WordPress.com settings

| Setting | Value |
|---------|-------|
| Repository | `ArtaQuest/artasite` |
| Branch | `main` |
| Mode | **Advanced** — needs the build step |
| Workflow | `.github/workflows/main.yml` |
| Artifact | `wpcom` |
| Destination directory | **`/`** |
| **Deploy on workflow run completion** | **on** — this is what makes it automatic |

**A green workflow is not a deploy.** Those are two separate systems: GitHub decides the commit is
good, and WordPress.com decides to fetch it. With the last setting off, CI goes green, the artifact
is built and published, the panel shows no error — and production keeps serving the previous commit
indefinitely. It looks exactly like success.

Observed: commit `16e75d1` passed CI at 17:13 and production was still executing the prior theme
version twenty minutes later. Nothing was broken; the toggle was simply off, and every signal
available from GitHub's side said the deploy had happened.

So a deploy is confirmed **only** by asking production what it is executing (below) — never by a
green check.

**Re-running a workflow does not deploy.** Only a real push does. Re-running `main.yml` from the
Actions tab produces a completed, green run and a fresh artifact, and WordPress.com ignores it. If
a commit is already on `main` and you need it deployed, push something — an empty commit is enough —
rather than re-running the job that built it.

**And do not read production's files as proof either.** `/srv/htdocs` accumulates leftovers from
every deploy this site has ever had: its `plugins/aquest/src/` holds more files than the repository
tracks, so a file being *present* says nothing about when it arrived. Check the **mtime**, or check
for a file the current commit **deletes** — `Health.php` was on production dated 11:32 from an older
push while the deploy that was supposed to add it had never run.

**The destination is `/`, not `/wp-content/`.** The artifact root already contains `wp-content/`, so
`/wp-content/` produces `/wp-content/wp-content/…` — a path WordPress never reads, leaving the site
silently unchanged while the deploy reports success. This was observed once; the stray copy was
removed.

## Verifying a deploy actually landed

A green deployment is not evidence. Ask production what it is **executing**:

```bash
curl -s https://artaquest.com/wp-json/aq/v1/version
# {"plugin":"1.20.567","theme":"1.8.10"}
```

Compare against `main`:

```bash
git show origin/main:wp-content/plugins/aquest/aquest.php | grep AQ_VERSION
git show origin/main:wp-content/themes/artaquest-theme/style.css | grep -i '^ \* Version:'
```

If they disagree, the deploy did not take effect — whatever the panel says.

## Why nothing deploys from a laptop

Production runs `opcache.validate_timestamps = 0` with `opcache.restrict_api = /usr/local/nginx/html/`.
Our own code cannot call `opcache_reset()`, and PHP copied in over SSH **never executes** — the
deploy reports success while the site keeps serving old bytecode. Only WordPress.com's own pipeline
invalidates that cache.

So the local deploy tooling is **gone**, not merely discouraged: the local deployer script is
deleted, `tools/ticket-agent/aq-deploy` refuses with exit 69, and the WordPress.com credential is
logged out — which removes the capability from the machine entirely, whoever runs whatever. Two
deploy paths racing WordPress.com's sync lock is what caused every outage this project has had, and
a retired-but-present tool is an invitation to recreate that.

**Break glass**, only when GitHub itself is unreachable — loud, logged, and overwritten by the next
deployment:

```bash
AQ_BREAK_GLASS=1 tools/ticket-agent/aq-deploy studio push --path . --options plugins --remote-site https://artaquest.com
```

It requires re-authenticating with WordPress.com first, which is intentional friction.

## Previewing a branch

Branch pushes are **verified**, not published — CI typechecks, lints and builds them, so a branch
that cannot build is caught before it is merged.

There is no per-branch live site, and adding one is not free: a preview needs its own WordPress
instance and database, which means either a WordPress.com preview site (re-authenticating the CLI)
or a second Atomic site. Run the SPA against production's API locally instead:

```bash
cd artaquest-web && npm run dev     # Vite proxies /wp-json to the backend
```
