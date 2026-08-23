/**
 * THE STUDIO — where a submission is made (operator order 2026-07-28).
 *
 * Authoring has moved to Kaggle. A member writes and runs their notebook there, then comes here
 * with one thing: the URL of its output page. This file is therefore no longer an editor; it is a
 * four-step intake, and the design goal is that a member never has to be told what to do next.
 *
 *   1. Paste      the link to a Kaggle notebook you have run
 *   2. Choose     which of its output files you want to publish
 *   3. Check      the reproducibility checklist, and fix anything it blocks on
 *   4. Publish    request it — and confirm from your own inbox
 *
 * Three deliberate decisions, each a UX decision as much as a correctness one:
 *   · The checklist runs THE MOMENT a URL is pasted, before anything is chosen. A private dataset
 *     should be reported while it is still one click to fix, not after the member has done the
 *     work of picking files.
 *   · Every failure carries its literal remedy next to it, written by the check that failed. A
 *     member should never have to work out what "blocked" means.
 *   · Nothing on this page can publish. Clearing every check only REQUESTS publication; the
 *     single-use secret emailed to the author is the mint. The step rail says so from step one, so
 *     the inbox round-trip at the end is never a surprise.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  deleteNotebook, getNotebook, importKernel, kernelOutputs, myNotebooks, publishNotebook,
  recheckNotebook, selectOutputs, Passkeys,
  NB_KINDS, type NbKind, type NotebookCard, type NotebookFull,
} from "../lib/api";
import { isLoggedIn } from "../lib/auth";
import { Checklist, KernelFacts } from "../components/checklist";
import { NB_KIND_META } from "../components/nbview";
import { ConfirmDialog,
  BackLink, Button, Card, Chip, EmptyState, Field, Input, PageHero, SearchPill, Select, SignInGate,
  SkeletonGrid, StatusNote, cx,
} from "../components/ui";

/** Mirrors Kernel::MAX_SELECTED — the server refuses more, so the UI never offers more. */
const MAX_FILES = 24;

const STEPS = [
  { key: "paste", n: 1, title: "Paste", hint: "a Kaggle notebook you have run" },
  { key: "choose", n: 2, title: "Choose", hint: "which output files to publish" },
  { key: "check", n: 3, title: "Check", hint: "the reproducibility checklist" },
  { key: "publish", n: 4, title: "Publish", hint: "confirm from your own inbox" },
] as const;

const msg = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;

/* ───────────────────────── the step rail ───────────────────────── */

function StepRail({ at }: { at: number }) {
  return (
    /* auto-fit, not `sm:grid-cols-4`: `sm:` is a 640px VIEWPORT query while the shell leaves this
        page a ~410px content column at an 1100px window and ~366px at 1024 — four fixed tracks were
        97px each there, and a step is a 12px uppercase label plus a hint. Each step asks for 9rem and
        the row takes as many as fit: four at 1440, two at 1100, one on a phone. */
    <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2">
      {STEPS.map((s) => {
        const done = s.n < at;
        const now = s.n === at;
        return (
          <li
            key={s.key}
            aria-current={now ? "step" : undefined}
            className={cx(
              "rounded-card border p-3",
              now ? "border-yang bg-yang/5" : done ? "border-line bg-space-2" : "border-line/60",
            )}
          >
            <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">
              <span
                aria-hidden
                className={cx(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold",
                  now ? "bg-yang text-on-accent" : "bg-space-3 text-ink-3",
                )}
              >
                <span data-ay-skip="1">{done ? "✓" : s.n}</span>
              </span>
              {s.title}
            </p>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{s.hint}</p>
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────────────────── 1. paste ───────────────────────── */

/**
 * Mirror of Kaggle::parse_url, client-side.
 *
 * The server is still the authority — this exists so a member sees what we understood BEFORE they
 * press anything, and so a mistyped link is caught without a round trip. Returning the parsed pair
 * lets the box echo it back: "we read this as <owner>/<slug>" is the difference between a form that
 * feels like a guess and one that feels like it is listening.
 */
function parseKaggleUrl(raw: string): { owner: string; slug: string } | null {
  let u = raw.trim();
  if (u === "") return null;
  // The browser's URL() NORMALISES dot-segments ("/code/../../etc/passwd" → "/etc/passwd") while
  // PHP's wp_parse_url does not, so without this the box would happily echo "Reading etc/passwd"
  // and enable Continue for a link the server then rejects. Refuse them before parsing.
  if (/(^|\/)\.\.?(\/|$)/.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  let parsed: URL;
  try { parsed = new URL(u); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (host !== "kaggle.com" && host !== "www.kaggle.com") return null;
  let seg = parsed.pathname.split("/").filter(Boolean);
  if (seg[0] === "code" || seg[0] === "kernels") seg = seg.slice(1);
  if (seg.length < 2) return null;
  const [owner, slug] = seg;
  const RESERVED = ["datasets", "competitions", "models", "discussions", "learn", "organizations", "writeups", "benchmarks"];
  if (RESERVED.includes(owner.toLowerCase())) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(slug)) return null;
  return { owner, slug };
}

function PasteBox({ onDone }: { onDone: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const parsed = useMemo(() => parseKaggleUrl(url), [url]);
  const typed = url.trim() !== "";

  const submit = () => {
    if (!parsed || busy) return;
    setBusy(true);
    setErr("");
    importKernel(url.trim())
      .then((r) => onDone(r.id))
      .catch((e: unknown) => setErr(msg(e, "That link could not be read.")))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="p-5">
      <h2 className="text-[17px] font-bold">Paste your Kaggle notebook</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
        Open the notebook you have already run on Kaggle and copy the address from your browser. The
        output page is the one to use, though any link to the notebook works.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          className="min-w-0 flex-1"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://www.kaggle.com/code/…"
          aria-label="Kaggle notebook address"
          aria-invalid={typed && !parsed}
          aria-describedby="aq-paste-hint"
          value={url}
          onChange={(e) => { setUrl(e.currentTarget.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <Button onClick={submit} disabled={busy || !parsed}>
          {busy ? "Reading it…" : "Continue"}
        </Button>
      </div>

      {/* Echo back what we understood, the moment it is understandable. */}
      <p id="aq-paste-hint" aria-live="polite" className="mt-2 min-h-[1.25rem] text-[13px] leading-relaxed">
        {parsed ? (
          <span className="text-ink-2">
            Reading{" "}
            <span className="font-semibold text-ink"><span data-ay-skip="1">{parsed.owner}/{parsed.slug}</span></span>
          </span>
        ) : typed ? (
          <span className="text-yin-ink">
            That does not look like a Kaggle notebook link. It should look like
            {" "}<span data-ay-skip="1">https://www.kaggle.com/code/your-name/your-notebook</span>
          </span>
        ) : null}
      </p>

      {err !== "" && <StatusNote error className="py-3 text-start">{err}</StatusNote>}

      <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-3">
        <p>
          Nothing is published by pasting a link. We read the notebook from Kaggle's public API and
          show you exactly what a stranger would be able to open and re-run.
        </p>
        <p>
          Haven't written one yet?{" "}
          <a href="https://www.kaggle.com/code" target="_blank" rel="noopener noreferrer" className="font-semibold text-yin-ink hover:underline">
            Start a notebook on Kaggle
          </a>
          , run it with Save Version → Save &amp; Run All, then come back with the link.
        </p>
      </div>
    </Card>
  );
}

/* ───────────────────────── 2. choose ───────────────────────── */

type OutFile = { name: string; class: string; ext: string };

function FilePicker({ nb, selection, kind, onSaved }: { nb: number; selection: string[]; kind: string; onSaved: () => void }) {
  const [files, setFiles] = useState<OutFile[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [all, setAll] = useState(0);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState("");
  const [onlyMedia, setOnlyMedia] = useState(true);
  const [picked, setPicked] = useState<string[]>(selection);
  const [pickKind, setPickKind] = useState<string>(kind);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { setPicked(selection); }, [selection]);
  useEffect(() => { setPickKind(kind); }, [kind]);

  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    // Every listing is a live, paginated call to Kaggle — typing must not fire one per keystroke.
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setErr("");
    kernelOutputs(nb, { q: debouncedQ || undefined, serveable: onlyMedia })
      .then((r) => {
        if (!live) return;
        setFiles(r.items);
        setCounts(r.counts);
        setAll(r.all);
        setTotal(r.total);
        setNext(r.next);
      })
      .catch((e: unknown) => { if (live) { setFiles(null); setErr(msg(e, "Could not list the run output.")); } });
    return () => { live = false; };
  }, [nb, debouncedQ, onlyMedia]);

  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : p.length >= MAX_FILES ? p : [...p, name]));

  const save = () => {
    setBusy(true);
    setErr("");
    selectOutputs(nb, picked, pickKind || undefined)
      .then((r) => { onSaved(); if (r.voided) setErr("Your confirm link was cancelled because the published files changed — request publication again."); })
      .catch((e: unknown) => setErr(msg(e, "Could not save your choice.")))
      .finally(() => setBusy(false));
  };

  const dirty = useMemo(
    () => picked.length !== selection.length || picked.some((p) => !selection.includes(p)) || pickKind !== kind,
    [picked, selection, pickKind, kind],
  );

  const shown = files ?? [];

  const loadMore = () => {
    if (next === null || more) return;
    setMore(true);
    kernelOutputs(nb, { q: debouncedQ || undefined, serveable: onlyMedia, cursor: next })
      .then((r) => { setFiles((f) => [...(f ?? []), ...r.items]); setNext(r.next); })
      .catch((e: unknown) => setErr(msg(e, "Could not load more files.")))
      .finally(() => setMore(false));
  };

  return (
    <Card className="p-5">
      <h2 className="text-[17px] font-bold">Choose what to publish</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
        These are the files your run wrote. Pick the ones that are the work itself — each becomes a
        citable item in the Library that anyone can attach to a post.
      </p>

      {all > 60 && (
        <p className="mt-3 rounded-card border border-line bg-space-3 p-3 text-[13px] leading-relaxed text-ink-2">
          This run wrote <span data-ay-skip="1">{all.toLocaleString()}</span> files, which usually
          means a cloned repository or a cache landed in the output folder beside the real result.
          Only the files you pick here are published.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchPill className="min-w-0 flex-1 basis-full sm:basis-auto" placeholder="Filter by name" value={q} onChange={setQ} />
        <Chip active={onlyMedia} onClick={() => setOnlyMedia(true)}>Publishable</Chip>
        <Chip active={!onlyMedia} onClick={() => setOnlyMedia(false)}>Everything</Chip>
      </div>

      {Object.keys(counts).length > 0 && (
        <p className="mt-2 text-[12.5px] text-ink-3">
          <span data-ay-skip="1">
            {Object.entries(counts).filter(([k]) => k !== "other").map(([k, v]) => `${v} ${k}`).join(" · ")}
          </span>
        </p>
      )}

      {files === null && err !== "" ? (
        <StatusNote error className="py-6 text-start">{err}</StatusNote>
      ) : files === null ? (
        <SkeletonGrid count={4} media={false} className="mt-4" />
      ) : shown.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="Nothing matches"
          body={onlyMedia
            ? "Try Everything — this run may have written a format the Library cannot serve."
            : "Try a different filter."}
        />
      ) : (
        <ul className="mt-4 max-h-[26rem] divide-y divide-line/50 overflow-y-auto rounded-card border border-line">
          {shown.map((f) => {
            const on = picked.includes(f.name);
            const full = !on && picked.length >= MAX_FILES;
            return (
              <li key={f.name}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={full}
                  onClick={() => toggle(f.name)}
                  className={cx(
                    "flex min-h-[44px] w-full items-center gap-3 p-3 text-start transition-colors disabled:opacity-40",
                    on ? "bg-yang/10" : "hover:bg-space-3",
                  )}
                >
                  <span
                    aria-hidden
                    className={cx(
                      "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[12px] font-bold",
                      on ? "border-yang bg-yang text-on-accent" : "border-line",
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink" title={f.name}>
                    <span data-ay-skip="1">{f.name}</span>
                  </span>
                  <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] uppercase text-ink-3">
                    <span data-ay-skip="1">{f.class || f.ext || "file"}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {total > shown.length && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-[12.5px] text-ink-3">
            Showing <span data-ay-skip="1">{shown.length}</span> of <span data-ay-skip="1">{total}</span>.
          </p>
          {next !== null && (
            <Button variant="ghost" size="sm" onClick={loadMore} disabled={more}>
              {more ? "Loading…" : "Show more files"}
            </Button>
          )}
        </div>
      )}

      {err !== "" && <StatusNote error className="py-3 text-start">{err}</StatusNote>}

      {picked.length > 0 && (
        <div className="mt-4 max-w-sm">
          <Field label="What kind of work is this?">
            <Select
              value={pickKind}
              onChange={setPickKind}
              options={NB_KINDS.map((k: NbKind) => ({ value: k, label: NB_KIND_META[k]?.label || k }))}
            />
          </Field>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
            We guess this from the files you picked. Correct it if the guess is wrong — it decides
            which shelf your work appears on, nothing more.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save selection" : picked.length ? "Selection saved" : "Pick a file to continue"}
        </Button>
        <span className="text-[13px] text-ink-3">
          <span data-ay-skip="1">{picked.length}</span> of <span data-ay-skip="1">{MAX_FILES}</span> chosen
        </span>
      </div>
    </Card>
  );
}

/* ───────────────────────── the work page ───────────────────────── */

function WorkFlow({ id }: { id: number }) {
  const [nb, setNb] = useState<NotebookFull | null>(null);
  // Delete-confirmation state lives up here with the rest: this component returns early while the
  // work is loading, and a hook declared after that return would run in a different order on the
  // first render than on the second.
  const [askDrop, setAskDrop] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  // Publishing REQUIRES a device passkey, and the confirm page is the last possible place to learn
  // that. Ask now, so the requirement is signposted while there is still something to do about it.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => { Passkeys.list().then((r) => setHasKey(r.items.length > 0)).catch(() => setHasKey(null)); }, []);

  const load = useCallback(() => {
    getNotebook(id)
      .then((n) => setNb(n as NotebookFull))
      .catch(() => setErr("That submission could not be loaded."));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (err !== "" && !nb) return <StatusNote error>{err}</StatusNote>;
  if (!nb) {
    return <div className="mx-auto w-full max-w-4xl px-4 py-8"><SkeletonGrid count={3} media={false} /></div>;
  }

  const checks = nb.checks || null;
  const facts = checks?.facts;
  const selection = nb.selection || [];
  const pending = nb.status === "pending";
  const published = nb.status === "published";
  const step = published || pending ? 4 : !selection.length ? 2 : nb.publishable ? 4 : 3;

  const recheck = () => {
    setBusy("check");
    setNote("");
    recheckNotebook(id)
      .then(() => { load(); setErr(""); setNote("Re-read from Kaggle."); })
      .catch((e: unknown) => setErr(msg(e, "Could not re-check.")))
      .finally(() => setBusy(""));
  };

  const request = () => {
    setBusy("publish");
    setNote("");
    setErr("");
    publishNotebook(id)
      .then((r) => {
        load();
        setNote(r.emailed === false
          ? "A confirm link was already sent for this work in the last hour — check your inbox, or try again later."
          : "Check your inbox — your single-use confirm link is on its way.");
      })
      .catch((e: unknown) => setErr(msg(e, "Could not request publication.")))
      .finally(() => setBusy(""));
  };

  // PERMANENT (operator 2026-08-16). It used to unlist a published work and keep everything under
  // the hood; now the row, its files on our storage, its Library listings (and their attachments in
  // anybody's post), its comments, hearts and challenge entries are all destroyed. Two things must
  // be said before the click, because they are the two things a member would be right to be angry
  // about afterwards: a minted DOI keeps resolving (to a "deleted by the author" notice — a DOI is a
  // promise that a link resolves), and the copy Zenodo archived at publication is NOT ours to
  // withdraw. The confirmation is a typed word, not a native confirm(): a native dialog is one
  // reflexive Enter away from destroying a published work.
  // Confirmed in OUR surface, not the browser's: window.prompt is unstyleable, blocks the tab,
  // is truncated to a strip by Safari — hiding the very sentences that say what cannot be undone —
  // and can be permanently suppressed in Firefox, which would leave a delete button that silently
  // does nothing. Same ConfirmDialog the work's own page uses, so the two doors to one act cannot
  // describe it differently.
  const drop = () => setAskDrop(true);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <ConfirmDialog
        open={askDrop}
        busy={dropping}
        word="DELETE"
        title="Delete this submission permanently?"
        confirmLabel="Delete for good"
        onCancel={() => setAskDrop(false)}
        onConfirm={() => {
          setDropping(true);
          deleteNotebook(id).then(() => { window.location.href = "/studio"; }).catch(() => { setDropping(false); setAskDrop(false); });
        }}
        body={<>
          <p>The notebook copy, its published files, its comments and its hearts are destroyed. This cannot be undone.</p>
          {nb?.doi_link ? <p>Its DOI stays a valid link and will say the work was deleted by its author. The copy Zenodo archived when it was published is outside our control.</p> : null}
          <p className="text-ink-3">Your notebook on Kaggle is untouched.</p>
        </>}
      />
      <BackLink href="/studio">All submissions</BackLink>

      <PageHero
        className="mt-4"
        eyebrow={published ? "Published" : pending ? "Waiting for your confirmation" : "Draft"}
        title={nb.title || facts?.title || "Untitled submission"}
        lede="Everything below is read back from your notebook on Kaggle. Nothing publishes until you confirm it from your own inbox."
      />

      {nb.kernel?.url && (
        <p className="mt-3 text-[13px] text-ink-3">
          <a href={nb.kernel.url} target="_blank" rel="noopener noreferrer" className="text-yin-ink hover:underline">
            <span data-ay-skip="1">{nb.kernel.owner}/{nb.kernel.slug}</span>
          </a>
          {" on Kaggle"}
        </p>
      )}

      {checks && <KernelFacts facts={checks.facts} className="mt-3" />}

      <div className="mt-6"><StepRail at={step} /></div>

      {note !== "" && <StatusNote className="py-3 text-start">{note}</StatusNote>}
      {err !== "" && <StatusNote error className="py-3 text-start">{err}</StatusNote>}

      <div className="mt-4 space-y-4">
        {!published && <FilePicker nb={id} selection={selection} kind={nb.kind || ""} onSaved={load} />}

        {checks && (
          <Card className="p-5">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[17px] font-bold">The reproducibility checklist</h2>
              {!published && (
                <Button variant="ghost" size="sm" onClick={recheck} disabled={busy === "check"}>
                  {busy === "check" ? "Re-reading…" : "Re-check"}
                </Button>
              )}
            </div>
            {!published && (
              <p className="mb-4 text-[14px] leading-relaxed text-ink-2">
                Fixed something on Kaggle? Press Re-check and this list updates.
              </p>
            )}
            <Checklist checks={checks} />
            {/* The JupyterBook page, before the irreversible act rather than after it (operator
                2026-07-29). An author asked to sign off on a publication should have read the thing
                they are publishing, in the form a reader will actually meet it — not inferred it
                from a file list. Works on a draft, so it costs nothing to look. */}
            <div className="mt-4 border-t border-line pt-4">
              <Button variant="outline" href={`/nb/${nb.id}/${nb.slug}/book`}>
                Read it as a book, the way a reader will
              </Button>
            </div>
          </Card>
        )}

        {published ? (
          <Card className="p-5">
            <h2 className="text-[17px] font-bold">Published</h2>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
              This work is live, and its files are in the Library for any member to attach to a post.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button href={`/nb/${nb.id}/${nb.slug}/`}>Open the work</Button>
              <Button variant="outline" href={`/nb/${nb.id}/${nb.slug}/book`}>Read as a book</Button>
              {nb.doi_link !== "" && <Button variant="ghost" href={nb.doi_link}>Cite it</Button>}
            </div>
          </Card>
        ) : (
          <Card className="p-5">
            <h2 className="text-[17px] font-bold">Publish</h2>
            {pending ? (
              <>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                  A single-use confirm link is in your registered inbox. Opening it shows you the
                  work one last time; only your explicit confirmation there publishes it and mints
                  the permanent DOI. Nothing running on this server can do that for you.
                </p>
                <div className="mt-4">
                  <Button variant="ghost" onClick={request} disabled={busy === "publish"}>
                    {busy === "publish" ? "Sending…" : "Send the link again"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                  {nb.publishable
                    ? "Everything checks out. Requesting publication emails you a single-use link — your confirmation there, signed by your device passkey, is what publishes the work and mints its permanent DOI."
                    : nb.gate_reason || "Clear the checklist above first."}
                </p>
                {hasKey === false && (
                  <p className="mt-3 rounded-card border border-yang/50 bg-yang/5 p-3 text-[13px] leading-relaxed text-ink-2">
                    You will need a <span className="font-semibold text-ink">passkey</span> to publish —
                    your device signs the exact work, which is what makes your publication impossible
                    for anyone else, even us, to forge.{" "}
                    <a href="/user-account/?settings=1" className="font-semibold text-yin-ink hover:underline">
                      Add one now
                    </a>{" "}
                    so the confirm link works first time.
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button onClick={request} disabled={!nb.publishable || busy === "publish"}>
                    {busy === "publish" ? "Requesting…" : "Request publication"}
                  </Button>
                  <Button variant="ghost" onClick={drop}>Delete submission</Button>
                </div>
              </>
            )}
          </Card>
        )}
      </div>
    </main>
  );
}

/* ───────────────────────── the studio home ───────────────────────── */

const STATUS_LABEL: Record<string, string> = {
  published: "Published",
  pending: "Waiting for your email confirmation",
  draft: "Draft",
};

function StudioHome() {
  const [items, setItems] = useState<NotebookCard[] | null>(null);

  useEffect(() => {
    myNotebooks().then((p) => setItems(p.items)).catch(() => setItems([]));
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <PageHero
        eyebrow="Studio"
        title="Publish a reproducible notebook"
        lede="Write and run your notebook on Kaggle, then bring the link here. We check that anyone could open it, re-run it from public inputs, and get the files you are publishing."
      />

      <div className="mt-6"><StepRail at={1} /></div>

      <div className="mt-4">
        <PasteBox onDone={(id) => { window.location.href = `/studio/nb/${id}`; }} />
      </div>

      <h2 className="mt-10 text-[17px] font-bold">Your submissions</h2>
      {items === null ? (
        <SkeletonGrid count={3} media={false} className="mt-4" />
      ) : items.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="Nothing here yet"
          body="Paste a Kaggle notebook link above to make your first submission."
        />
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((w) => (
            <li key={w.id}>
              <a
                href={`/studio/nb/${w.id}`}
                className="flex min-h-[44px] items-center gap-3 rounded-card border border-line bg-space-2 p-4 transition-colors hover:border-yang/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">
                    {w.title || "Untitled submission"}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] text-ink-3">
                    {STATUS_LABEL[w.status] || "Draft"}
                  </span>
                </span>
                <span aria-hidden className="inline-block text-ink-3 rtl:-scale-x-100">→</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default function NotebookStudio() {
  const { id } = useParams();

  if (!isLoggedIn()) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <SignInGate
          title="Your Studio"
          body="Sign in to publish a reproducible notebook. Your submissions, and the inbox that confirms them, belong to your account."
        />
      </main>
    );
  }
  return id ? <WorkFlow id={Number(id)} /> : <StudioHome />;
}
