# ArtaQuest submissions — the reproducibility contract

**Effective 2026-07-28 (operator order), amended 2026-08-04.** A submission is a **public Kaggle
notebook that has been run**, from a **Kaggle account the submitting member has proved they
control**. The author pastes the URL of that notebook's output page, picks which of its output files
to publish, and an exhaustive **reproducibility checklist** runs against Kaggle's public API.
Published files land in the **Library**, where any member can attach them to their posts.

Everything the platform asserts about a work is read back from Kaggle and listed, item by item, in
public. Nothing is graded, ranked or judged; no number is attached to a work. This file is the
contract; the code that enforces it is `wp-content/plugins/aquest/src/Kernel.php` (the checklist),
`Kaggle.php` (the read client), `KaggleId.php` (the account proof) and `Notebook.php` (the author's
key). Keep the five in sync.

## The claim we make

Four facts, each checkable by a stranger with no account and no credential:

| # | The fact | How anyone re-checks it |
|---|----------|-------------------------|
| 1 | The notebook is **public** on Kaggle | `GET /kernels/pull` answers 200 and reports `isPrivate` false |
| 2 | Every one of its **inputs is public** — datasets, models, notebooks | each declared source is probed on its own endpoint |
| 3 | The run **finished** and produced these exact files | the run log carries Kaggle's own completion marker (`[NbConvertApp] Writing … to __results__`); `kernels/output` lists the files |
| 4 | It ran with the **internet switched off** — or, if not, we say so plainly | `enableInternet` on Kaggle's own record |

Our checklist is not a private judgement. It is a public assertion anybody can re-run against the
same public API and contradict.

A fifth claim is about people rather than about the run, so it sits in **Whose notebook is it** below:
the member who submitted the work has **proved they control the Kaggle account it belongs to**. It
holds for every submission made from 2026-08-04, and for none of the three works published before
that date. It is re-runnable by a stranger too — read from the same endpoint, which needs no
credential, out of a public notebook whose URL we keep and publish.

## Whose notebook is it

**A member may submit only a notebook from a Kaggle account they have proved they control** (operator
decision 2026-08-04). This replaced the rule of 2026-07-28, under which any member could submit any
public notebook.

The reason for the change is the DOI. Publication mints a permanent CC-BY citation crediting the
notebook's Kaggle author, and under the old rule that author had never been asked and might never
learn of it. Every other blocking item on the checklist describes something an author can go and fix;
this one describes something a stranger cannot undo, because a citation of record is built to outlive
the kernel it came from.

### The proof, step by step

It runs entirely on Kaggle's credential-free read API, so it is not a private judgement either — a
stranger can repeat it against the same kernel, today or next year.

1. **You claim a handle** in Account → Your Kaggle handle. A bare username, an `@handle` or any
   Kaggle URL works; the username is taken out of it and stored lowercased.
2. **We mint a one-time string** and show it to you once. We store only its **sha256**. Every row of
   this database is public, so the string itself is never written down here — nobody at ArtaQuest can
   read it back to you, and losing it costs nothing: claim again for a fresh one, and the old one
   stops working.
3. **You put that string in a public notebook under that handle** — any cell, or the title — and
   paste that notebook's URL back to us.
4. **We read that kernel back off Kaggle's public endpoint** — literally
   `GET /kernels/pull?userName=<the handle you claimed>&kernelSlug=<the slug in your URL>` — and
   check three things. It answers **200** — for that URL only a notebook that exists, opens without
   a login and sits under *that account* does, because Kaggle answers 403 for one that is private,
   deleted, or simply not that account's, and it matches the handle case-insensitively, as we do.
   Its metadata **confirms it is not private**, which we read rather than infer from the status
   code. And its source or its title carries a string whose sha256 is the fingerprint we stored —
   we look for the fingerprint, never for the string, because we do not hold the string.
5. On success the handle is marked **verified**, the fingerprint is cleared — a proved row keeps no
   verifier at all — and the **URL of the proof kernel is kept**: on your account page, and in the
   register itself, which like every other table here is public in the Data explorer. The check
   stays re-runnable by anyone; the claim is not "we checked once, trust us".

That endpoint takes **no credential at all**, re-verified 2026-08-04: an unauthenticated `GET` of the
call in step 4 answers 200 with the full metadata and source, and the same call naming the wrong
owner answers 403. Our own client sends the platform's Kaggle token, because it sends one on every
Kaggle call; the endpoint does not ask for it. A stranger running that URL with no account, no key
and no permission from us gets the same answer we did — which is what makes this a check anybody can
repeat, rather than one only we can make.

Only **one member** may hold a handle as verified. Two members may hold competing *pending* claims on
the same handle, deliberately: only one of them can produce the string, and refusing the second claim
at the point of asking would let anybody block a handle they do not own.

### What that proves, and what it does not

It proves **control of the account** at the moment of the proof — enough to write inside it, which is
all Kaggle lets anyone establish from the outside. It does **not** prove who wrote which cell. A
notebook can have collaborators; an account can be shared or handed over. We claim what we check, and
what we check is the account.

The proof kernel is also yours to edit or delete. We record where we read the string so anybody can
go and re-read it; if you take that notebook down, the verified row stays and its evidence does not.
Leave the proof notebook up if you want the check to stay repeatable by a stranger.

### Who gets the credit

Because the account is proved, the member who publishes a submission made under this rule is the
notebook's Kaggle author, and the citation credits them:

- The permanent DOI records the **Kaggle author, exactly as Kaggle reports them**, as the creator;
  the ArtaQuest member is recorded as a **contributor**. For a submission under this rule that is two
  names for one person — the two platforms hold different names for you — not two people.
- The exported BibTeX names the Kaggle author.
- Where the two names differ, the work's page still says so in plain words and links the Kaggle
  profile. That line predates the ownership rule and stays: a display name is not an identity, and
  showing both is the honest thing whatever the reason for the difference.
- The publication request goes to the **member's own registered email address**. It always did. What
  changed is that the inbox and the credit now belong to the same person.

**Everything published before this rule existed is outside it** — three works as this is written
(`9318`, `9319`, `9321`; count them yourself in the Data explorer under `aq_notebooks`, or in
`GET /wp-json/aq/v1/notebooks`). All three were submitted by the same member, and they name **two
different Kaggle accounts**; nothing in their record *proves* either link. The check did not exist
when they were published, no path ever re-inspects a published row, and their frozen checklists
therefore do not carry the item. Any blanket statement about published work on this platform should
be read with that exception in mind — including on this page.

Silent re-attribution would be the single most dishonest thing this platform could do, and a DOI is
permanent — so this is enforced in the deposit itself, not only in the interface.

## The gate — two keys, strictly in order

| # | Key | Who holds it | What it takes |
|---|-----|--------------|---------------|
| 1 | **The reproducibility checklist** | Kaggle's public API, read back item by item | ~20 deterministic checks in four groups. Every blocking check must pass. Warnings are shown loudly and never block. Every check names the exact evidence it read. |
| 2 | **The author** — the member who submitted it, from a Kaggle account they proved is theirs | their own registered email + their device passkey | Publication is REQUESTED, never taken. A single-use secret goes to the address that member registered with; their click, plus their device passkey signature over the work, is what publishes it and mints the permanent DOI. No token, agent, relay or operator can stand in for that. |

The secret goes to **the member who submitted the notebook** — they are the one with an inbox we can
reach and a passkey we can verify. Since 2026-08-04 that member has also proved they control the
Kaggle account the notebook belongs to, so on a new submission the person who consents and the person
credited are the same human. They remain two separate **roles** in the code, and deliberately so:
consent is checked against an inbox and a device, credit is read off Kaggle, and neither is ever
inferred from the other.

**Precisely what key two guarantees.** Exactly one code path sets a work's status to
`published`: `Notebook::author_confirm()`, reached only by an explicit `POST` carrying the raw
secret. That secret is 160 random bits, it exists nowhere but the member's inbox — the database
stores only `sha256(secret|sig(ipynb))`, and the database is public — and it is spent atomically with
the flip, so a race loses and a replay finds nothing. The confirmation is appended to the
append-only ledger **before** the flip, and where the database allows it a publish-guard trigger
refuses any `INSERT` or `UPDATE` into `published` that is not already preceded by that sig-bound row,
from any client at all. Whether that trigger layer is installed is recorded publicly in the
`aq_publish_guard` option, because an absent guard must be known-absent rather than imagined present.

What we do **not** claim is that the database is unwritable. Anyone with direct SQL access to the
server can write rows there; nothing in a doc changes that. What they cannot do is make the result
stand. `integrity_sweep()` re-derives the proof for every published row from public data: the ledger
row must be bound to the `sha1` of the exact source being served, its passkey assertion must
re-verify against the author's enrolled public key, and its challenge nonce must appear in no other
row. Anything that fails is demoted to a draft and the operator is alerted. The private key that
signs a confirmation is on the member's own device and has never been on our server, so a forged
publication cannot be made to verify — it can only be made to appear, briefly, until the sweep runs.

## The flow, in the author's words

Prove your Kaggle account, once → paste a Kaggle notebook URL → pick the files to publish → read the
checklist → request publication → confirm from your inbox.

The proof is a one-off. Prove a handle and every notebook under it can be submitted from then on; you
can prove more than one account if you have more than one.

The checklist runs the moment the URL is pasted, before any files are chosen — a private dataset
should be reported straight away, not after the work of choosing files. Checks that are still waiting
on a selection are **pending**, not failures. Publication needs blocks and pending both at zero.

**Changing what you publish withdraws the request.** The emailed secret and the passkey signature
bind the notebook's `sha1`, not the file list, so altering the selection while a confirmation is
outstanding voids the link, clears the token and spends nothing. You get a fresh link when you ask
again. A published work is then immutable here: re-pasting its URL will not re-pull its source,
because that source is what its confirmation ledger row is signed against.

## The checklist

Four groups, in the order an author reads them:

| Group | The question it answers |
|-------|-------------------------|
| `open` | Can anyone open it? |
| `inputs` | Can anyone re-run it? |
| `run` | Did that run produce these files? |
| `rigour` | How repeatable is the result? |

Severity is binary and honest. **BLOCK** covers three kinds of fact, and no others: one that makes the
run un-repeatable by a stranger (a private input, a needed credential, a run that ended in a crash); our
own limits on what we can store and serve (at most 24 files, 512 MB each, 1 GB in total, in a type we
can render); and a drawing we cannot rebuild from an allow-list. **WARN** is judgement: surfaced
prominently, never in the way.

### Can anyone open it?

| id | The check | Severity | What it reads |
|----|-----------|----------|---------------|
| `owner_proven` | The submitter has proved they control the Kaggle account | BLOCK | the register of proved handles (`aq_kaggle_ids`), against the kernel's owner |
| `kernel_public` | The notebook is public on Kaggle | BLOCK | `GET /kernels/pull` status and `metadata.isPrivate` |
| `source_readable` | Its code can be read | BLOCK | `blob.source` — its byte length and cell counts |

`owner_proven` is asked **first**, and answered without touching Kaggle: the work of proving happened
earlier, in the register, and this only asks it one question. It sits in this group because `open` is
the group asking who a notebook belongs to and who can reach it; the other three groups are about the
run, and none of them is about consent.

Where it cannot be answered — the register is unreadable, or the checklist is being run outside a
member session — the item is neither passed nor failed. It is emitted as **pending**, which refuses
publication (that needs blocks *and* pending both at zero) while accusing nobody. A green tick beside
"the account is theirs" on a signal we never read would be the exact quiet overclaim this gate exists
to refuse; a cross would blame an author for a fault in our plumbing.

Nothing already published can be turned into a failure by this check. A published row is never
re-inspected — the checklist a stranger reads on a published work is the frozen report stored at
submission, and `integrity_sweep()` reads the ledger and the signatures, never the checklist.

### Can anyone re-run it?

| id | The check | Severity | What it reads |
|----|-----------|----------|---------------|
| `datasets_public` | Every input dataset is public | BLOCK | each `datasetDataSources` ref, probed on `datasets/view` |
| `models_public` | Every input model is public | BLOCK | each `modelDataSources` ref, probed on `models/…/get` |
| `kernels_public` | Every input notebook is public | BLOCK | each `kernelDataSources` ref, probed on `kernels/pull` |
| `no_secrets` | It needs no private credentials | BLOCK | the source, for `kaggle_secrets`, `UserSecretsClient`, `get_secret(`, `set_tensorflow_credential`, `get_gcloud_credential` |
| `competitions` | Competition data is declared | WARN | `competitionDataSources` — **disclosure only**, never an assertion |

A notebook whose dataset is private reads perfectly for its author and is dead for everyone else, and
nothing in the notebook itself reveals that. A notebook that needs a private credential is exactly as
un-runnable, so it is treated the same way. Competition data is disclosed rather than asserted: a
reader must join that competition and accept its rules first, and Kaggle's competition endpoints are
401 for us, so we report what the notebook declares and claim nothing further.

### Did that run produce these files?

| id | The check | Severity | What it reads |
|----|-----------|----------|---------------|
| `has_run` | It has actually been run | BLOCK | `GET /kernels/output` status plus a non-empty run log |
| `run_completed` | The run finished | BLOCK | Kaggle's own completion marker, matched **on stderr only**: `[NbConvertApp] Writing … to __results__`. Absent + a traceback ⇒ blocked. Absent + no traceback ⇒ downgraded to a WARNING, because we genuinely cannot tell |
| `has_output` | The run produced files | BLOCK | the file list from `kernels/output` |
| `selection` | You have chosen what to publish | BLOCK | the chosen names are still in the current output, and there are at most 24 |
| `type_supported` | Every chosen file is a type we can serve | BLOCK | the extension, against `Kernel::TYPES` (audio · image · scene · video · model3d · data · weights · doc · notebook) |
| `files_fetchable` | Every chosen file downloads | BLOCK | a one-byte ranged GET per file |
| `size_limit` | Every chosen file is within the size limit | BLOCK | 512 MB per file, 1 GB per submission |
| `svg_safe` | Every chosen drawing is self-contained and carries no code | BLOCK | the real bytes of each chosen `.svg`, rebuilt by `Svg::clean()` from an allow-list of shapes, gradients, styles and animation — no script, no embedded document, no reference to another host. An SVG is the only artifact a browser executes, so we publish our own rebuild rather than the file as it arrived |

`run_completed` reads a POSITIVE marker, not the absence of a bad one. Kaggle's runner always ends a
successful notebook by converting it and writing the rendered result, so that line is decisive.
The marker is matched **only against stderr**, where Kaggle's runner writes. A notebook's own
`print()` goes to stdout, so an author cannot certify their own crashed run by echoing the line.

A naive traceback scan is wrong, and testing rather than reasoning caught it:
`alexisbcook/titanic-tutorial` is a healthy, completed run whose log nevertheless contains a full
traceback — Kaggle's own interpreter teardown (`Error in atexit._run_exitfuncs`) — and every event in
that log, marker included, is on stderr. So: the marker decides, teardown noise is discounted, an
author's own caught-and-swallowed traceback is reported as `run_clean` below, and a log carrying
neither marker nor traceback WARNS rather than blocks, because we genuinely cannot tell.

"Has output" can never be the gate on its own. The operator's own example kernel lists 1,322 output
files — a `git clone` checkout — and produced none of the audio it was written to produce, because it
died on its first real cell. That is precisely why the log is read.

### How repeatable is the result?

Every check in this group is a **warning**. None of them blocks.

| id | The check | What it reads |
|----|-----------|---------------|
| `internet_off` | It ran with the internet switched off | `enableInternet` — Kaggle's own record of the run |
| `seeded` | Randomness is seeded | the libraries the source imports, against `np.random.seed`, `random.seed`, `torch.manual_seed`, `tf.random.set_seed` |
| `pinned_installs` | In-notebook installs are pinned | `pip install` lines, for package tokens carrying no `==` version |
| `no_wall_clock` | The result does not depend on the clock | `datetime.now(`, `date.today(`, `time.time(`, `datetime.utcnow(` |
| `accelerator` | It runs on ordinary hardware | `enableGpu`, `enableTpu`, `machineShape` — disclosed, so readers know what re-running costs |
| `env_pinned` | The environment image is pinned | `dockerImage`, for an exact `@sha256:` digest |
| `output_focused` | The output is the work, not a checkout | how much of the run output the selection represents |
| `run_clean` | The run log is free of errors | tracebacks printed mid-run and then swallowed |

## What the gate rests on — the Kaggle API, verified 2026-07-28

| Endpoint | What it gives us |
|----------|------------------|
| `GET /kernels/pull` | 200 for ANY public kernel, **with no credential at all** — the privacy flag, the internet and accelerator flags, the sha256-pinned image, all four data-source lists, and the notebook source |
| `GET /kernels/output` | 200 — the output files, the page token, and the full run log |
| `GET /datasets/view/{ref}` | 200 public · 403 private-or-gone |
| `GET /models/{ref}/get` | 200, with an explicit `isPrivate` |
| `GET /kernels/status` · `/kernels/list` · `/competitions/list` | **401** for us, in every auth mode — do not "fix" these back in |

Because `kernels/status` is closed to us, run health is read from the **run log**, which is decisive:
a crashed Kaggle run leaves its traceback as the last thing in the log and writes nothing after it.

## How to pass first time

1. **Prove your Kaggle account first** — it takes a minute and you only do it once. Submit a notebook
   from an account you have not proved and the very first item on the checklist blocks it.
2. **Make it public before you paste it** — the notebook, and every dataset, model and notebook it
   attaches. A reader who cannot open your inputs cannot re-run your work.
3. **Save & Run All on Kaggle, and let it finish.** Files left behind by a crashed run are not a
   result.
4. **Write your result into `/kaggle/working`**, ideally into a clean subfolder, so a reader can find
   it among whatever else the run leaves behind.
5. **Switch Internet off** unless the work genuinely needs it. Anything downloaded at run time can
   change or vanish, and then a reader gets a different result.
6. **Seed every library you draw randomness from**, at the top of the notebook.
7. **Pin every install** as `name==version`. A different version next month is a different experiment.
8. **Keep the clock out of your output.** If `datetime.now()` reaches a published file, no re-run can
   match it.
9. **Check your inbox.** Passing the checklist only *requests* publication: your emailed confirmation,
   signed by your device passkey, is what publishes the work and mints the DOI.

## Free

Submitting, checking and publishing are all free. The Foundation runs on donations.

## The DOI, and why it still exists

The Kaggle kernel is **provenance** — it is where the run happened and where anyone can hit Copy &
Edit → Run All for themselves. The **DOI** (member-facing as `/d/n<id>`) is the **citation of
record**, because a kernel is owner-editable and owner-deletable and a DOI is not.

For the same reason, everything published is **mirrored to our CDN at publish time**. A Kaggle kernel
can be edited, made private or deleted by its owner; a citation must not rot.

## Honest limits

- **A 403 is ambiguous.** A private resource and a deleted one answer identically, so we never guess
  which it is — we say **"not publicly readable"**, which is the honest verdict either way.
- **The account proof is not an authorship proof.** It establishes that a member could write inside a
  Kaggle account, which is what makes them the right person to consent to a citation in that
  account's name. It says nothing about who wrote a given cell, and we never claim otherwise.
- **The proof is dated, and the works published before it are not covered.** It arrived 2026-08-04;
  everything published before that date — three works, naming two Kaggle accounts — carries no such
  item and was never re-checked, because nothing re-inspects a published row. "Every published work
  was author-verified" is not a sentence this platform may write.
- **We do not execute anything.** Kaggle does. We read its record and report it.
- **We do not enforce the offline condition.** Kaggle enforces it; we read the flag. The correct
  phrasing, everywhere, is "ran with the internet switched off, on Kaggle's own record".
- **Reproducible means what it says and no more.** Anyone can hit Copy & Edit → Run All on Kaggle,
  from public inputs, and get this. That is weaker than the retired promise that the same bytes came
  out of a repeated run on our own machine, and stronger than "trust our laptop". Both halves are
  true; neither may be overclaimed.
- **A confirmation is bound to this hostname.** The passkey assertion the sweep re-verifies covers
  the site's own domain, so a work signed under an old hostname stops verifying after a domain move
  and is demoted to a draft until its author confirms again. The gate is behaving correctly — it will
  not serve a publication whose proof it cannot check — but the cost of that lands on the author, and
  it is ours to have caused.
- **Warnings are warnings.** An unseeded run, a GPU requirement or an unpinned install is disclosed
  and published. Readers decide what that is worth.
- **The accepted trade-off, stated plainly.** A mechanical checklist cannot catch work that is hollow
  or dishonest but technically valid. The retired AI review could. We accept that loss in exchange for
  a gate that is fast, free, and checkable by anyone — with hearts, member-founded challenges and the
  public checklist receipt as the counterweight.
