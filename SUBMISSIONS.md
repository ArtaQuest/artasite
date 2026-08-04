# ArtaQuest submissions — the reproducibility contract

**Effective 2026-07-28 (operator order).** A submission is a **public Kaggle notebook that has been
run**. The author pastes the URL of that notebook's output page, picks which of its output files to
publish, and an exhaustive **reproducibility checklist** runs against Kaggle's public API. Published
files land in the **Library**, where any member can attach them to their posts.

Everything the platform asserts about a work is read back from Kaggle and listed, item by item, in
public. Nothing is graded, ranked or judged; no number is attached to a work. This file is the
contract; the code that enforces it is `wp-content/plugins/aquest/src/Kernel.php` (the checklist),
`Kaggle.php` (the read client) and `Notebook.php` (the author's key). Keep the four in sync.

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

## Who gets the credit

**Any member may submit any PUBLIC Kaggle notebook** (operator decision 2026-07-28) — you do not
have to own it. What follows from that is a rule, not a nicety: **the notebook is credited to its
Kaggle author**, always.

- The permanent DOI records the Kaggle author as the **creator**; the ArtaQuest member who brought
  it here is recorded as a **contributor**.
- The exported BibTeX names the Kaggle author.
- Where the submitter and the author differ, the work's page says so in plain words, and links the
  Kaggle profile.

Silent re-attribution would be the single most dishonest thing this platform could do, and a DOI is
permanent — so this is enforced in the deposit itself, not only in the interface.

## The gate — two keys, strictly in order

| # | Key | Who holds it | What it takes |
|---|-----|--------------|---------------|
| 1 | **The reproducibility checklist** | Kaggle's public API, read back item by item | ~20 deterministic checks in four groups. Every blocking check must pass. Warnings are shown loudly and never block. Every check names the exact evidence it read. |
| 2 | **The author** | the creator's own registered email + their device passkey | Publication is REQUESTED, never taken. A single-use secret goes to the author's own registered email; their click, plus their device passkey signature over the work, is what publishes it and mints the permanent DOI. No token, agent, relay or operator can publish. Ever — not via the API, not via wp-cli, not via SQL. |

## The flow, in the author's words

Paste a Kaggle notebook URL → pick the files to publish → read the checklist → request publication →
confirm from your inbox.

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
| `kernel_public` | The notebook is public on Kaggle | BLOCK | `GET /kernels/pull` status and `metadata.isPrivate` |
| `source_readable` | Its code can be read | BLOCK | `blob.source` — its byte length and cell counts |

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

1. **Make it public before you paste it** — the notebook, and every dataset, model and notebook it
   attaches. A reader who cannot open your inputs cannot re-run your work.
2. **Save & Run All on Kaggle, and let it finish.** Files left behind by a crashed run are not a
   result.
3. **Write your result into `/kaggle/working`**, ideally into a clean subfolder, so a reader can find
   it among whatever else the run leaves behind.
4. **Switch Internet off** unless the work genuinely needs it. Anything downloaded at run time can
   change or vanish, and then a reader gets a different result.
5. **Seed every library you draw randomness from**, at the top of the notebook.
6. **Pin every install** as `name==version`. A different version next month is a different experiment.
7. **Keep the clock out of your output.** If `datetime.now()` reaches a published file, no re-run can
   match it.
8. **Check your inbox.** Passing the checklist only *requests* publication: your emailed confirmation,
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
- **We do not execute anything.** Kaggle does. We read its record and report it.
- **We do not enforce the offline condition.** Kaggle enforces it; we read the flag. The correct
  phrasing, everywhere, is "ran with the internet switched off, on Kaggle's own record".
- **Reproducible means what it says and no more.** Anyone can hit Copy & Edit → Run All on Kaggle,
  from public inputs, and get this. That is weaker than the retired promise that the same bytes came
  out of a repeated run on our own machine, and stronger than "trust our laptop". Both halves are
  true; neither may be overclaimed.
- **Warnings are warnings.** An unseeded run, a GPU requirement or an unpinned install is disclosed
  and published. Readers decide what that is worth.
- **The accepted trade-off, stated plainly.** A mechanical checklist cannot catch work that is hollow
  or dishonest but technically valid. The retired AI review could. We accept that loss in exchange for
  a gate that is fast, free, and checkable by anyone — with hearts, member-founded challenges and the
  public checklist receipt as the counterweight.
