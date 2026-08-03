# Contributing to ArtaQuest

Thank you for wanting to help. Two ways in:

## 1. Report or suggest on the live site (easiest)

Open **[artaquest.com/issues/](https://artaquest.com/issues/)** and file a ticket —
bug, feature, content fix, or idea. ArtaBot triages it with you. Contributions are
public and credited: each ticket category has its own leaderboard, and you earn a
point when a ticket you opened is resolved.

## 2. Work on the code

Read these first — they are short and they are the real rules:

- **CLAUDE.md** — project shape, conventions, and what not to do.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — why the system is shaped this way.
- **tools/ticket-agent/COORDINATION.md** — how
  humans and AI agents share this codebase without stepping on each other.

The short version of the conventions:

- Backend: one route per row in `Rest::ROUTES`, one static method on a domain class.
  Normalized `aq_*` tables, append-only ledgers, keyset cursors — never OFFSET, never
  `wp_posts` for high-volume data, all SQL through `$wpdb->prepare()`.
- Frontend: pages are presentational; all backend calls go through
  `artaquest-web/src/lib/api.ts`. No permanently hardcoded English UI text.
- Brand: gold `#E8B923` + blue `#2352E8`, never a third accent. British spelling.
- Never commit secrets. The entire database is public by design — secrets live in
  environment variables or the encrypted vault, never in the DB or the repo.
- Commit explicit paths (`git commit -- <paths>`); `npm run build` output in
  `wp-content/themes/artaquest-theme/app/` is regenerable — don't hand-edit it.
- **No machine attribution in commit messages.** No `Co-authored-by:` trailer for a
  tool, and no "generated with" line. GitHub reads a co-author trailer as a
  CONTRIBUTOR, so one trailer lists a tool beside the people who built this. CI
  enforces it on every commit in a push, and a rejected message cannot be fixed
  afterwards — `main` is protected against force-pushes, so the bad message stays in
  history and only the next push turns the branch green again. Get it right the first
  time. Note this applies to AI assistants whose default is to add such a trailer:
  that default is wrong here, and the rule is not about hiding how the work was done —
  say that in the message body if it matters.
  - **The gate greps the whole message, not just its trailers.** So a commit that
    merely *mentions* the forbidden trailer by name — say, one documenting this rule —
    fails too. Describe it, don't quote it. (Both failure modes were hit in a row while
    writing this entry, which is why it says so.)

Verify before you ship: `cd artaquest-web && npx tsc --noEmit && npm run build`,
and the plugin test harness under `wp-content/plugins/aquest/tools/`.

## License

By contributing you agree your work is released under
[AGPL-3.0-or-later](LICENSE).
