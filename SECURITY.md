# Security policy

## Reporting a vulnerability

Email **support@artaquest.org** with the details (or open a ticket at
[artaquest.org/issues/](https://artaquest.org/issues/) marked *security* if the
issue is not sensitive). You'll get a human (or a very capable bot) reply, and
fixes ship fast — the platform deploys continuously.

## What counts as a vulnerability here

ArtaQuest practises **radical transparency**: the entire database — including
member names, emails, activity, and balances — is public by design at `/data/`.
Reports that member data is "exposed" there are working as intended, not a bug.

What we *do* treat as serious vulnerabilities:

- Leakage of **secrets**: API keys, payment/signing keys, SMTP credentials, session tokens,
  sign-in codes, API token hashes, or a live publication-confirm verifier. (Password hashes,
  including administrators', are public in `/data` by design — password login is disabled
  platform-wide, so a read hash is inert.)
- **Authentication bypass** — acting as another member, or reaching wp-admin
  without operator credentials.
- **Ledger integrity** — any way to mint, duplicate, or redirect coins/points
  outside the append-only ledgers, or to break the full-reserve gold backing.
- **Code execution / injection** — SQL injection, XSS, SSRF, webshells, or
  tampering with the deployed code (an integrity watchdog monitors for this).
- **Moderation bypass** that lets hate/fear content score into competitions.

## The premise the transparency rests on

Publishing the whole database is only safe while **no secret is in it**. That premise binds our own
code — `AQ\Secrets::get()` resolves from an environment variable or a `wp-config.php` constant and
never from an option — but it does not bind the platform we run on. On 2026-08-04 **Jetpack**, a
WordPress.com plugin we do not control and never reviewed, was found holding a live `blog_token` in
the `wp_options` row `jetpack_private_options`, which the explorer had been serving to anyone who
asked, with no credential.

Two conclusions are in the code now, and both should stay there:

- **Redaction is default-deny by the shape of a key** (`Extra::redact_row`, `Extra::REDACT_NAME_RE`),
  applied to every key/value store in the database — options, site meta, user, post, term and comment
  meta. An allow-list of columns only ever covers code we wrote, and the next platform plugin to
  stash a credential will not ask permission first. So a key segment reading `token`, `secret`, `key`,
  `salt`, `password`, `private`, `credential` or `auth` has its value withheld by default, whoever
  wrote it, and a second net withholds values that are unmistakably credentials whatever the key is
  called. Only the value is withheld: the row, its key and every other column stay public.
- **Masking is not a remedy, only a tourniquet.** It stops the next request. It does not unpublish
  what was already downloadable, and the nightly `/offline` export mirrors whatever the explorer
  served. Anything that was once publicly readable must be treated as disclosed and **rotated** —
  the redaction buys the time to rotate, and nothing more.

## Hardening already in place

Password logins are disabled (email one-time codes + Google only); secrets load
from environment/vault only (never the DB); an hourly watchdog plants honeytrap
options, verifies admin rosters and ledger proofs, and alerts the operator; a
filesystem integrity monitor sweeps for webshells and cron persistence.
