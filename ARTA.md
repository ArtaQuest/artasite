# Arta here — the integration side

Arta is the mascot: a stick figure with no face who greets people on the landing
page, waits during sign-up, and has a profile at `/arta`.

**Arta is not authored in this repository.** The rig, the physics, the pose
library, the films and the animation style guide live in
[artalife](https://github.com/ArtaQuest/artalife). Generation and integration
are separate pipelines: that repo makes the character, this one shows it. The
animation laws — the motion-safety ceiling, the three laws, cadence, colour,
the anti-patterns — are all in its `ARTA.md`, and questions about how Arta
*moves* are answered there, not here.

This file covers only what is true because Arta lives inside **this** site.

## What we consume, and how

| Vendored here | From |
|---|---|
| `artaquest-web/src/generated/arta/rig/arta.ts` | artalife `src/rig/arta.ts` |
| `artaquest-web/src/generated/arta/render/Arta.tsx` | artalife `src/render/Arta.tsx` |
| `tools/arta-audit.mjs` | artalife `tools/arta-audit.mjs` |

```
node tools/arta-sync.mjs           # pull from ../artalife (or a shallow clone)
node tools/arta-sync.mjs --check   # fail if the vendored copy has drifted
```

**Never edit a generated file** — every one of them carries a banner saying so. The next sync overwrites it,
and in the meantime the mascot has quietly forked. Make the change upstream,
push, re-sync. `--check` exits non-zero on drift and is safe to gate a build on.

The vendored tree mirrors upstream's `rig/` + `render/` layout rather than
flattening it — partly so no import path needs rewriting, but mainly because
`arta.ts` and `Arta.tsx` in one directory differ only in case: that resolves on
Linux and fails on macOS, which is a CI-green, laptop-broken build.

It lives under `generated/`, not `vendor/`, because `**/vendor/` is gitignored
here for composer — and because the directory name is the first warning anyone
gets before editing a file they shouldn't.

Films (`dist/scenes/*.svg`) are **not** bundled. A finished film reaches members
the same way every other work does — submitted as a Kaggle notebook, checked,
published by its author, mirrored into the Library. `--scenes` exists for the
case where one is needed as a static asset; nothing uses it today.

## Where Arta is mounted

- `components/AppShell.tsx` — the page-level companion.
- `pages/Landing.tsx`, `pages/Login.tsx`, `pages/ArtaProfile.tsx` — these import
  only the command bus (`arta`) and ask for a gesture; they never drive frames.

Arta's gold is `--color-arta` and its tools are `--color-arta-tool` (blue), both
in `index.css`, both defined for either theme. They are the brand pair, so the
"gold + blue sum to white" rule governs them like everything else.

## Lessons that belong to this side

- **A top-level SPA route whose slug is a PREFIX of an existing page 301s.**
  `/arta` redirected to `/artaillustration/` in production and the profile page
  was unreachable, while working perfectly on the dev server. SPA routes here
  are served through WordPress's 404 path, and `redirect_guess_404_permalink`
  fires first, guessing the nearest page by slug. Routes like `games` and
  `library` avoid it by having a real published WP page of the same slug;
  `/arta` now has one too. **Check a new top-level route on production** — the
  dev server has no WordPress in front of it.

- **Don't believe a mid-flight read of a deploy.** A chunk 404ing right after a
  push is usually the sync still applying: WP.com writes `<name>.partial.<hash>`
  and renames. Check for `.partial.` files before concluding anything is
  missing. (And `ls dir/*.js | wc -l` returns 0 when the glob exceeds the
  argument limit — the prod assets directory holds ~39,000 files, because
  assets accumulate across deploys and are never pruned.)

- **`-z-10` on the mascot.** Rendered perfectly, underneath the page background,
  and never once seen. A stacking context is an integration property: the same
  component is correct on its own and invisible in a layout.

- **Run the behavioural audit against production, not only the dev server.**
  `node tools/arta-audit.mjs <url>` (it drives a Chrome with a debug port; a
  throwaway headless one cannot be throttled by whatever you have focused).
  The speed-clamp convergence bug passed every local run and failed on the first
  production run, because frame timing differs.

  That file is **generated**, like the rig. It has to exist here because it only
  runs against a site and this is the site; but it measures the CHARACTER — travel
  per frame against the speed ceiling, head oscillation, what reduced motion is
  left with — and those laws are upstream's. So it is synced rather than kept by
  hand on both sides: two hand-maintained copies of one test is precisely the
  drift this arrangement exists to prevent.
