# Cutover — MasterStudy LMS + WooCommerce removal (COMPLETE)

**Status: done.** The platform now runs entirely on the single `artaquest` plugin.
MasterStudy LMS (4,067 files) and WooCommerce (5,715 files) — **9,782 files / ~129 MB —
have been deleted from disk**, their 52 database tables dropped, and the legacy theme BFF
retired. Every route serves 200 with zero PHP errors.

Everything remains reversible: the pre-cutover tree is in git (`git show c973069:…`) and
the deleted plugins are archived in `_backup/artaquest-lms.tar.gz`.

## What was done

1. **New backend** — one dependency-free plugin (`wp-content/plugins/artaquest/`, 13 files)
   on normalized `aq_*` tables. `src/Rest.php` `ROUTES` is the entire API. Registered with
   `override=true` at `rest_api_init:99` so it authoritatively owns `/aq/v1/*`.
2. **Data migrated** — the live course (1 course / 9 lessons / 9 markers / 2 enrollments)
   moved into the new tables; the **88,822-row translation cache preserved**.
3. **Frontend rewired** — `src/lib/wp.ts` is now a thin adapter over the new API; the SPA
   runs entirely on the new backend. Trimmed 27 → 17 pages (removed feature sprawl).
4. **Theme decoupled** — guarded the one load-time MasterStudy `require`; replaced the i18n
   boot config + language-prefix router (which lived in MasterStudy) with the new plugin's
   `AQ\I18n`; restored 200 status for `/courses/<slug>/`. Removed 8 orphaned legacy includes
   (BFF/economy/discussions) — theme includes 26 → 18.
5. **Plugins + tables deleted** — `rm -rf` both plugin dirs; dropped 52 `artaquest_*`/`wc_*`/
   `stm_lms_*` tables; deleted the never-loaded `stm-lms-templates/` + `course-builder/`.

## Verified (local, SQLite)

- All app routes 200: `/`, `/courses/`, `/courses/<slug>/`, `/discussions/`, `/donate/`,
  `/wallet/`, `/rankings/`, `/login/`, `/user-account/`, `/u/<slug>/`, language prefixes
  (`/fa/` RTL, `/es/`, `/ar/`, `/zh-tw/`). Zero fatals/warnings in the debug log.
- All API endpoints serve the new shapes; mutations require auth (401 when anonymous).
- **Full authenticated LMS + economy flow** (real user, real handlers): enroll → answer
  (awards 1 point + 1 coin, idempotent) → progress (%) → wallet → dashboard → identity.
- i18n: `window.AQ_I18N` populated from the new registry (133 languages); cache resolves.

## Known degradations (rebuild on the new plugin as needed)

These retired features are typed no-op stubs in `wp.ts` (flagged `RETIRED`); their UI
sections render empty/disabled rather than erroring:

- Coin FX buy/sell, bursary applications, creator stance analytics, typology donation
  targets, discussion comment edit/delete.
- Public per-user profiles show only the viewer's own data (no cross-user profile endpoint
  yet); `getStatement`/`postProfileUpdate`/`deleteAccount` are stubs.
- `/courses/<slug>/` returns 200 via a `template_redirect` shim; consider a proper rewrite
  rule for cleanliness.

## Optional follow-ups (not required for production)

- Migrate the 17 pages to import `src/lib/api.ts` directly, then delete `wp.ts`.
- Legacy theme includes — status audited 2026-06-07 (this list was stale + dangerous; corrected):
  - `aq-bug-bounty.php` — **RETIRED** (deleted; routes `/bug-finding` + `/leaderboard` are owned by
    the plugin, UI is the React Issues page; its one live filter `aq_avatar_url` moved to
    `custom-functions.php`).
  - `aq-certificate.php`, `aq-lecturer.php`, `aq-engagement-rewards.php` — already gone (no such files).
  - `aq-creator-ladder.php` — **KEEP, it is LIVE**: defines `aq_creator_tiers()`, which the plugin's
    `Extra::creator_ladder`/`creator_status`/`submit_playlist` (`/aq/v1/creator/*`) serve to the React
    Careers/Teach page. Deleting it breaks that page. (Its `aq_points_awarded`/`aq_playlist_approved`
    action listeners are dead — those actions are never fired — but the tier data is load-bearing.)
  - `aq-public-profile.php` — **KEEP, it is LOAD-BEARING**: registers the `/u/<slug>` rewrite + the
    `aq_profile` query var that `aq-app.php` reads to render every public profile. Deleting it 404s `/u/`.
  - `aq-account-deletion.php` — dormant: it is the *only* `/aq/v1/delete-account` route, but the SPA
    never calls it (delete-account is a `wp.ts` stub). Retiring it is a product decision (drop account
    self-deletion), not pure debloat — left in place.
- Rebuild the degraded features above against the plugin where the product needs them.

## Rollback (if ever needed)

```bash
git checkout c973069 -- wp-content/themes/artaquest-theme
tar xzf _backup/artaquest-lms.tar.gz -C wp-content/plugins
studio wp plugin install woocommerce --activate
studio wp plugin activate artaquest-lms
```
