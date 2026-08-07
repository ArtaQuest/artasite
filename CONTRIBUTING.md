# Contributing to ArtaQuest

Thank you for wanting to help. Two ways in:

## 1. Report or suggest on the live site (easiest)

Open **[artaquest.com/issues/](https://artaquest.com/issues/)** and file a ticket —
bug, feature, content fix, or idea. ArtaBot triages it with you. Contributions are
public and credited: each ticket category has its own leaderboard, and you earn a
point when a ticket you opened is resolved.

## 2. Work on the code

Read these first — they are short and they are the real rules:

- **[README.md](README.md)** — what the platform is, and where every part of it lives. -
**[ARCHITECTURE.md](ARCHITECTURE.md)** — project shape, conventions, and why it is shaped this way.
- **tools/ticket-agent/COORDINATION.md** — how
  humans and AI agents share this codebase without stepping on each other.

The short version of the conventions:

- Backend: one route per row in `Rest::ROUTES`, one static method on a domain class.
  Normalized `aq_*` tables, append-only ledgers, keyset cursors — never OFFSET, never
  `wp_posts` for high-volume data, all SQL through `$wpdb->prepare()`.
- Frontend: pages are presentational; NEW backend calls go through
  `artaquest-web/src/lib/api.ts`. Some older paths still use `lib/wp.ts`, the
  compatibility bridge — do not add to it. No permanently hardcoded English UI text.
- Brand: gold `#E8B923` + blue `#1746DC`, never a third accent. British spelling.
  The pair are exact complements — they sum to white per channel (0xE8+0x17, 0xB9+0x46,
  0x23+0xDC = 255, 255, 255). `#2352E8` was the old value and sums to 267, which clips.
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
  - **The check asks git's trailer parser, not a grep.** Only a real trailer — that
    key at the start of a line in the final paragraph — creates a GitHub contributor,
    so only that is refused. Writing *about* the rule in a commit message is fine, and
    deliberately so: an earlier version grepped the whole message, rejected the very
    commits that documented it, and taught people to reword honest prose to appease a
    pattern. A check that punishes writing about itself is one people route around.

## Before you push

One command runs every gate CI runs — the same script, so green here means green there:

```bash
tools/preflight.sh          # secrets, route handlers, version bump, vendored content,
                            # php -l, tsc, lint (changed files), build, hollow-build
tools/preflight.sh --fast   # skip the build while you iterate
```

If you are working on the platform rather than reading it, `tools/aq` is the whole
cycle and is harder to use wrongly:

```bash
tools/aq status         # what has drifted, and what production is executing
tools/aq start <name>   # an isolated worktree branched from what production is built from
tools/aq check          # preflight, above
tools/aq ship           # refuse-or-push, then confirm production is EXECUTING it
```

`start` matters more than it looks. Branching from a checkout that has fallen behind
the deploy branch does not produce a conflict — it produces a silent revert of live
code, because the outbound direction copies rather than merges. `start` always branches
from `artasite/main`, and `ship` refuses a push that would make private paths public.

## License

By contributing you agree your work is released under
[AGPL-3.0-or-later](LICENSE).
