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

- Leakage of **secrets**: API keys, payment/signing keys, SMTP credentials,   session tokens, sign-in
codes, API token hashes, or a live publication-confirm   verifier. (Password hashes, including
administrators', are public in `/data` by   design — password login is disabled platform-wide, so a read
hash is inert.)
- **Authentication bypass** — acting as another member, or reaching wp-admin
  without operator credentials.
- **Ledger integrity** — any way to mint, duplicate, or redirect coins/points
  outside the append-only ledgers, or to break the full-reserve gold backing.
- **Code execution / injection** — SQL injection, XSS, SSRF, webshells, or
  tampering with the deployed code (an integrity watchdog monitors for this).
- **Moderation bypass** that lets hate/fear content score into competitions.

## Hardening already in place

Password logins are disabled (email one-time codes + Google only); secrets load
from environment/vault only (never the DB); an hourly watchdog plants honeytrap
options, verifies admin rosters and ledger proofs, and alerts the operator; a
filesystem integrity monitor sweeps for webshells and cron persistence.
