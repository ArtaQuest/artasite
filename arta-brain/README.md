# arta-brain — what answers `@arta`

Arta is a real ArtaQuest member (`@arta`, display name **Arta**). Members talk to it **only in public**:
tag `@arta` in a feed post, a reply or a comment, and Arta answers in that thread. Start with `bug:` and
Arta files a GitHub issue in `ArtaQuest/artasite` (labels `bug`, `from-arta`) and links it in the reply.

This directory is the brain: one small Node daemon on the operator's own Mac (see below; it was first
built for the Azure VM `artabot`, whose Linux installer `deploy/install.sh` still works). It is never deployed by the site's CI — `main.yml` ships `wp-content/`
only.

## Nothing is paid per reply

- Answers come **only** from the operator's flat-rate chat subscription, driven in a browser profile on
  the VM that the operator signed into by hand. There is **no** pay-per-token API anywhere in the code.
- When the subscription is unavailable (signed out, usage limit, page changed) or the brain's own pace
  cap is reached, mentions **wait** in the site's queue (`aq_mentions`, up to 48 h) and are answered when
  Arta is back. Arta does not post a placeholder reply: each mention has exactly one reply slot, and it is
  kept for the real answer. The feed tells the asker honestly that Arta has a queue.
- No Function App, no Storage, no Key Vault, no inbound port. The fixed cost is the VM itself.

## How a mention travels

```
member posts "@arta …"  ──►  WordPress: aq_mentions row (queued)       [src/Arta.php]
                                   ▲  │
              POST arta/pending ───┘  │   (every 10 s while busy, 30 s idle — also the heartbeat)
              POST arta/mentions/{id}/claim        exclusive, atomic
   brain ── chat page (one fresh conversation per mention, one at a time, paced)
              POST arta/reply {mention_id, body, kind, issue_url?}   exactly once per mention
              GitHub: issue (dedup by fingerprint + title, per-member and global daily caps)
```

All calls to the site are `POST` with `X-Arta-Token` (= `AQ_ARTA_REPLY_TOKEN`), so no edge cache can hold
them. The brain only ever sees public data (the post, its thread, public handles and names).

## Pace (so the account is used like a person would, not hammered)

`Pacer` (src/pacer.ts): one prompt at a time, at least `ARTA_MIN_GAP_SEC` (45) apart, at most
`ARTA_PER_HOUR` (30) and `ARTA_PER_DAY` (300) in rolling windows, persisted across restarts. A usage-limit
notice pauses Arta for `ARTA_BUSY_PAUSE_SEC`; a signed-out page pauses it for `ARTA_DOWN_PAUSE_SEC` and logs
`ENGINE DOWN`. The site's own global limits (`Arta::GLOBAL_PER_DAY` = 300) match, so the queue cannot grow
past what Arta can answer in a day. The browser engine is an ordinary browser: no stealth plugins, no
fingerprint spoofing, no CAPTCHA solving, no randomised "human" behaviour — if the service asks for a
check, a human handles it.

## Install on the VM (operator, once)

```bash
ssh arta@<vm-ip>
git clone https://github.com/ArtaQuest/artasite.git && cd artasite/arta-brain
./deploy/install.sh install     # Node 22, deps, Chromium, ~/.config/arta-brain/env (asks for the secrets), systemd unit
./deploy/install.sh login       # one-time sign-in (below)
./deploy/install.sh calibrate   # prints selector candidates → set ARTA_SEL_ANSWER in ~/.config/arta-brain/env
./deploy/install.sh check       # settings, site + token, sign-in state — sends no prompt
./deploy/install.sh start       # ARTA_DRY_RUN=1 first: answers are logged, nothing is posted
./deploy/install.sh logs
```

**Sign-in:** `login` starts a private display with VNC bound to the VM's localhost. From your own computer:
`ssh -L 6080:localhost:6080 arta@<vm-ip>`, open `http://localhost:6080/vnc.html`, sign in to the chat
service in the browser window (2FA as usual), open the chat page, send one message to confirm it answers,
then press Enter in the SSH session. The profile (cookies) stays in `~/.local/share/arta-brain/profile` on
the VM; nothing is copied anywhere else.

Settings live in `~/.config/arta-brain/env` (mode 600; template `deploy/env.example`). Secrets are never
logged; `check` prints names only.

| Setting | What |
|---|---|
| `ARTA_REPLY_TOKEN` | = the site's `AQ_ARTA_REPLY_TOKEN` (≥ 32 chars) |
| `GITHUB_ISSUES_TOKEN` | fine-grained PAT, `ArtaQuest/artasite` only, Issues: read & write |
| `ARTA_CHAT_URL` | the chat page (operator setting, not in the repo) |
| `ARTA_SEL_INPUT` / `ARTA_SEL_SEND` / `ARTA_SEL_ANSWER` | that page's selectors (`calibrate`) |
| `ARTA_MIN_GAP_SEC`, `ARTA_PER_HOUR`, `ARTA_PER_DAY` | pace caps |
| `BUGS_PER_USER_PER_DAY`, `BUGS_PER_DAY` | GitHub issue caps (3 / 40) |
| `ARTA_DRY_RUN` | `1` = log answers, post nothing |

## Run on the operator's Mac (current host)

The VM sign-in was refused by the service, so the brain runs on the operator's own Mac, signed in from
there. No git checkout on the Mac: build here, copy the bundle, install production dependencies there.

```bash
# on a build machine, from this directory:
npm ci && npm test && npm run build
tar czf arta-brain-mac.tgz dist/src package.json package-lock.json deploy
# on the Mac:
mkdir -p ~/ArtaBrain/app && tar xzf arta-brain-mac.tgz -C ~/ArtaBrain/app
cd ~/ArtaBrain/app && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
ln -sf ~/ArtaBrain/app/deploy/macos/arta-brain.sh ~/ArtaBrain/arta-brain
# ~/ArtaBrain/env (mode 600): deploy/env.example with the token, ARTA_CHAT_URL and ARTA_DRY_RUN=1
~/ArtaBrain/arta-brain install-agent   # writes the LaunchAgent, NOT loaded (disabled until start)
~/ArtaBrain/arta-brain login           # plain Chrome on ~/ArtaBrain/chrome-profile; sign in, then ⌘Q
~/ArtaBrain/arta-brain check           # then calibrate (top mode + a tiny PNG) → ARTA_SEL_ANSWER, ARTA_SEL_BUSY
~/ArtaBrain/arta-brain start           # launchd, KeepAlive; logs in ~/ArtaBrain/logs
```

The profile is a dedicated directory, never the everyday Chrome profile. The daemon drives the installed
Chrome (`ARTA_BROWSER_CHANNEL=chrome`), in a visible window by default (`ARTA_HEADLESS=0`). A sleeping Mac
answers nothing — mentions wait in the queue until it wakes.

## Highest effort, every time

Before each prompt, in each new conversation, the engine opens the page's mode picker and chooses the
first of `ARTA_MODE_LABELS` (default `Heavy,Expert,Thinking,Auto`) that the account offers. An option that
is missing, disabled or an upgrade offer — or a click after which the picker does not show the new label —
is remembered as unavailable and the next one is tried; it is logged once and never retried in a loop.
The choice is **verified** by reading the picker's label back. A mode's own usage-limit notice pauses
Arta like any other limit. Answers may think for minutes: `ARTA_ANSWER_TIMEOUT_SEC` defaults to 600, and
an answer counts as finished only when its text has stopped changing **and** the page's stop control is
gone (`ARTA_SEL_BUSY`).

## Files in and out

- **In.** `arta/pending` and `claim` list the public files on the mentioning post and on the posts above
  it (so "@arta what's this?" under a picture works): name, mime, size, URL, and `skip` (type / size /
  count) for the ones not handed over. At most 4 files, 20 MB each, only types the chat page reads
  (PNG, JPEG, GIF, WebP, PDF, text, Markdown, CSV, JSON). The brain downloads them (https only, size
  enforced while streaming) to a private temp dir, uploads them through the page's attach control, waits
  until the uploads finish, sends, and deletes the copies. Whatever could not be attached is named in
  the prompt.
- **Out.** When the answer does not fit the reply limit (or the model wrote a longer `details`), the reply
  is trimmed and the complete answer is attached as `answer.md`. Images the answer generated (and file
  links in it) are fetched through the signed-in page and attached. `arta/reply` takes them as
  multipart `files[]`; the site sniffs every file from its bytes (never the name), allows only the types
  above, caps 4 files / 10 MB each / 25 MB per reply, stores them content-addressed in the existing media
  store and shows them on the reply like any post attachment (on comments, as links under the text).

## Every mention gets a new conversation

`BrowserEngine.open()` opens a new tab on `ARTA_CHAT_URL` for each mention. If the page shows an earlier
answer (an app that reopens the last conversation), it clicks `ARTA_SEL_NEW_CHAT`; if an earlier answer is
still on screen, it refuses to send (`ENGINE DOWN`), so no member's words can reach another's answer. The
smoke test (`npm run smoke`) proves both paths against a stand-in page that restores its last conversation.

## Develop

```bash
npm ci && npm test        # unit tests: fake site, fake chat engine, fake GitHub
npx playwright install chromium && npm run smoke   # the browser engine against a local stand-in page
```
