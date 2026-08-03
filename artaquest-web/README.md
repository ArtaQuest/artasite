# ArtaQuest — React front-end

The entire ArtaQuest front-end, built in React (Vite + React Router + Tailwind v4).
It carbon-copies Kaggle's geometry while keeping ArtaQuest's two-colour brand
(gold #E8B923 "the Why" / blue #2352E8 "the How") on deep-space surfaces.

## Architecture (hybrid, WordPress.com-Business deployable — no Node runtime)

- **React owns every surface** — home/dashboard, discussions, thread, courses,
  course detail, rankings, profile — reading data from WordPress via same-origin
  REST (`/wp-json`). Cookie + nonce auth in production; a localhost dev-shim in dev.
- **WordPress serves only the "necessary SEO content"**: on each route it emits the
  page's **schema.org JSON-LD** + a server-rendered content fallback inside
  `#aq-app-root` (the crawler / no-JS layer). React renders over it on load. So the
  app is React for users and fully crawlable for search engines + LLMs.
- Ships as a **static bundle inside the WP theme** (`wp-content/themes/artaquest-theme/app/`,
  produced by `npm run build`). The theme's `template-aq-app.php` serves it. No Node, no Vercel.

## Develop

```bash
npm install          # uses ./.npm-cache
npm run dev          # http://localhost:5173 — proxies /wp-json -> Studio WP (:8881)
```

The Vite dev proxy injects `X-AQ-Dev-User` so authenticated endpoints resolve without
the cross-origin cookie (see `vite.config.ts` + the WP dev-shim in
`includes/aq-headless-api.php`).

## Build + deploy

```bash
npm run build        # -> wp-content/themes/artaquest-theme/app/ (hashed bundle + manifest)
```

The bundle is committed with the theme and deployed via `studio push` — no separate
front-end host. WP reads the Vite manifest to enqueue the current hashed entry.

## Layout

- `src/components/AppShell.tsx` — sidebar + topbar shell (responsive: off-canvas drawer on mobile)
- `src/pages/*` — one component per surface (Home, Discussions, Thread, Courses, CourseDetail, Rankings, Profile)
- `src/lib/wp.ts` — typed REST client + the public BFF fetchers (`aq/v1/*`)
- `src/index.css` — Tailwind `@theme` tokens (Kaggle geometry · ArtaQuest colour) + `.aq-prose` markdown styles
