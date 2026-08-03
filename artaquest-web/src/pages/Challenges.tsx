import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isLoggedIn, localePath, currentUser, relAgo } from "../lib/wp";
import { Challenges as Api, Social, ApiError, type ChallengeCard, type ChallengeDetail, type ChallengeEntry, type ChallengeKind, type ChallengeSeason } from "../lib/api";
import { Avatar, Button, Card, EmptyState, StatusNote, SkeletonGrid, HeartGlyph, VotePill, cx } from "../components/ui";

/**
 * CHALLENGES — the one competition frame for EVERY content type (generalized 2026-07-11):
 * books, music, audiobooks, animations, films, illustrations, papers, datasets and models all
 * compete the same way. Like any competition, a challenge has a LEADERBOARD (hearts-ranked
 * entries), a DISCUSSION board (inline talk), and RESULTS (frozen past seasons) — surfaced as
 * three tabs on a thread-like page. The hub is a board index; anyone starts a challenge for ₳1.
 * Mobile-first single column throughout.
 */

const KINDS: ChallengeKind[] = ["book", "music", "audiobook", "animation", "film", "illustration", "paper", "dataset", "model"];
const MEDAL = ["🥇", "🥈", "🥉"];

/** Per-kind copy: the label, and how a new entry comes to exist (all entries are automatic —
 *  make the thing through its own surface and it lands on the season's board). */
const KIND_META: Record<ChallengeKind, { label: string; enterHref: string; enterLabel: string; auto: string }> = {
  book:         { label: "Book",         enterHref: "/library/?type=book",         enterLabel: "Write a book",        auto: "Publishing enters automatically — the fee joins the pot." },
  music:        { label: "Track",        enterHref: "/library/?type=music",        enterLabel: "Compose a track",     auto: "Publishing enters automatically — the fee joins the pot." },
  audiobook:    { label: "Audiobook",    enterHref: "/library/?type=audiobook",    enterLabel: "Record an audiobook", auto: "Publishing enters automatically — the fee joins the pot." },
  animation:    { label: "Animation",    enterHref: "/library/?type=animation",    enterLabel: "Animate a topic",     auto: "Publishing enters automatically — the fee joins the pot." },
  film:         { label: "Film",         enterHref: "/library/?type=film",         enterLabel: "Make a film",         auto: "Publishing enters automatically — the fee joins the pot." },
  illustration: { label: "Illustration", enterHref: "/library/?type=illustration", enterLabel: "Commission art",      auto: "Publishing enters automatically — the fee joins the pot." },
  paper:        { label: "Paper",        enterHref: "/research/",                  enterLabel: "Submit a paper",      auto: "Journal-accepted papers enter automatically." },
  dataset:      { label: "Dataset",      enterHref: "/competitions/new/",          enterLabel: "Host a dataset",      auto: "Hosting a dataset enters it automatically — the fee joins the pot." },
  model:        { label: "Model",        enterHref: "/library/?type=competition",  enterLabel: "Enter a competition", auto: "Solutions verified by ArtaCompete enter automatically." },
};

function closesIn(secs: number): string {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const chip = "inline-flex items-center gap-1 rounded-pill border border-line px-2.5 py-1 text-[12.5px] text-ink-2 whitespace-nowrap";
const chipGold = "inline-flex items-center gap-1 rounded-pill border border-yang/40 bg-yang/10 px-2.5 py-1 text-[12.5px] font-semibold text-yang whitespace-nowrap";

function KindTag({ kind }: { kind: ChallengeKind }) {
  return <span className="rounded bg-yin/15 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-yin-light">{KIND_META[kind]?.label ?? kind}</span>;
}

/* ═══════════════════════════ The board index (hub) ═══════════════════════════ */

function Hub() {
  const nav = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof Api.list>> | null>(null);
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false);
  const logged = isLoggedIn();
  useEffect(() => { Api.list().then(setData, () => setErr("The challenges could not load — try again shortly.")); }, []);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-ink">Challenges</h1>
        <p className="text-[14px] leading-relaxed text-ink-3">Every kind of work competes — books to models. Make something, collect hearts, split the pot at the new moon. Or start your own challenge.</p>
      </header>

      {data && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={chipGold}>Season {data.season.label}</span>
          <span className={chip}>Closes in {closesIn(data.season.closes_in)}</span>
          {!data.payouts_live && <span className={cx(chip, "text-ink-3")}>Preview — pots pay from the next new moon</span>}
        </div>
      )}

      {logged ? (
        starting
          ? <StartForm createFee={data?.create_fee ?? 1} endsLabel={data?.season.ends_label ?? ""} onDone={(id) => { setStarting(false); if (id) nav(localePath(`/challenges/${id}/`)); }} />
          : <Button onClick={() => setStarting(true)} className="w-full sm:w-auto">+ Start a challenge (₳{data?.create_fee ?? 1})</Button>
      ) : (
        <p className="text-[13px] text-ink-3">
          <a href={localePath("/login/")} className="font-semibold text-yin-light hover:underline">Sign in</a> to enter or start a challenge — anyone can heart the entries.
        </p>
      )}

      {err && <StatusNote error>{err}</StatusNote>}
      {data === null && !err ? <SkeletonGrid count={6} /> : data && (
        <ul className="flex list-none flex-col divide-y divide-line/70 rounded-card border border-line bg-space-1/40">
          {data.items.map((c) => <IndexRow key={c.id} c={c} />)}
        </ul>
      )}

      <details className="rounded-card border border-line p-3 text-[13px] leading-relaxed text-ink-2">
        <summary className="cursor-pointer font-semibold text-ink">How the pots work</summary>
        <p className="mt-2">
          Fees are the prize: publishing pays the studio fee into the seasonal pot, starting a challenge seeds its
          pot with ₳1, and entering one costs ₳1 more. The pot pays 100% of its fees to the top three by hearts —
          50% / 30% / 20% — at the new moon: everything participants pay in goes back to participants. A pot
          needs at least 5 entrants and 10 hearters to pay; otherwise it
          rolls into next season, so nothing is ever lost. One heart per member per work, never your own;
          reciprocal heart rings don't count; every heart is public in the Data explorer. Every entrant earns the
          season's certificate. Datasets and models also compete on their own metric arena — hearts pick the
          best-loved, the hidden holdout picks the most accurate.
        </p>
      </details>
    </div>
  );
}

function IndexRow({ c }: { c: ChallengeCard }) {
  return (
    <li>
      <Link to={localePath(`/challenges/${c.system ? c.kind : c.id}/`)}
        className="flex min-h-[56px] items-center gap-3 px-3 py-2.5 no-underline transition-colors hover:bg-veil/5 active:bg-veil/10">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <KindTag kind={c.kind} />
            <span className="truncate text-[15px] font-semibold text-ink">{c.title}</span>
          </span>
          <span data-ay-skip={c.owner ? "1" : undefined} className="mt-0.5 block truncate text-[12.5px] text-ink-3">
            {c.system ? "Seasonal — every publish enters" : `by ${c.owner?.name ?? "a member"}`} · {c.entries} {c.entries === 1 ? "entry" : "entries"}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[15px] font-bold tabular-nums text-yang">₳{c.pool}</span>
          <span className="block text-[11px] text-ink-3">pot</span>
        </span>
        <span aria-hidden className="shrink-0 text-ink-3">›</span>
      </Link>
    </li>
  );
}

/** Start a member challenge — three fields, one tap. */
function StartForm({ createFee, endsLabel, onDone }: { createFee: number; endsLabel: string; onDone: (id?: number) => void }) {
  const [kind, setKind] = useState<ChallengeKind>("book");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setErr("");
    if (title.trim().length < 4) return setErr("Give it a title (a few words).");
    setBusy(true);
    try {
      const r = await Api.create({ kind, title: title.trim(), brief: brief.trim() || undefined });
      onDone(r.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not start the challenge");
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="text-[15px] font-bold text-ink">Start a challenge</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What is it for?">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={cx("rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
              kind === k ? "border-yin bg-yin/10 text-ink" : "border-line text-ink-3 hover:border-yin/50")}>
            {KIND_META[k].label}
          </button>
        ))}
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder='A title — e.g. "Best space western"'
        className="w-full rounded-card border border-line bg-space-1 px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-yin/60 focus:outline-none" />
      <textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={1000} rows={3} placeholder="The prompt (optional) — what should entries go for?"
        className="w-full rounded-card border border-line bg-space-1 px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-yin/60 focus:outline-none" />
      {err && <StatusNote error>{err}</StatusNote>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={busy}>{busy ? "Starting…" : `Start it — ₳${createFee}`}</Button>
        <button type="button" onClick={() => onDone()} className="text-[13px] font-semibold text-ink-3 hover:text-ink">Cancel</button>
        <span className="text-[12px] text-ink-3">₳{createFee} seeds the pot · closes {endsLabel}</span>
      </div>
    </Card>
  );
}

/* ═══════════════════════════ One challenge (the competition page) ═══════════════════════════ */

type Tab = "board" | "talk" | "results";

function Detail({ chKey }: { chKey: string }) {
  const [d, setD] = useState<ChallengeDetail | null>(null);
  const [season, setSeason] = useState(0); // 0 = current
  const [tab, setTab] = useState<Tab>("board");
  const [err, setErr] = useState("");
  useEffect(() => {
    setD(null); setErr("");
    Api.detail(chKey, season || undefined).then(setD, () => setErr("This challenge could not load — try again shortly."));
  }, [chKey, season]);
  const frozen = !!d?.frozen;
  const s = d && !frozen && typeof d.season === "object" ? (d.season as ChallengeSeason) : null;
  const showTab: Tab = frozen ? "results" : tab; // a settled/past view IS the results

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5">
      <p className="text-[13px]">
        <Link to={localePath("/challenges/")} className="font-semibold text-ink-3 no-underline hover:text-ink">‹ All challenges</Link>
      </p>
      {err && <StatusNote error>{err}</StatusNote>}
      {d === null && !err ? <SkeletonGrid count={4} /> : d && (
        <>
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2"><KindTag kind={d.kind} /></div>
            <h1 className="text-[24px] font-bold leading-tight tracking-tight text-ink">{d.title}</h1>
            <p data-ay-skip={d.owner ? "1" : undefined} className="text-[13px] text-ink-3">
              {d.system
                ? `The season's open ${KIND_META[d.kind].label.toLowerCase()} board — every ${KIND_META[d.kind].label.toLowerCase()} made this season is in.`
                : <>started by {d.owner?.slug ? <a href={localePath(`/u/${d.owner.slug}/`)} className="font-semibold text-ink no-underline hover:text-yin-light">{d.owner.name}</a> : d.owner?.name}</>}
            </p>
            {d.brief && <p className="rounded-card border border-line bg-space-1/50 px-3 py-2.5 text-[14px] leading-relaxed text-ink-2">{d.brief}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={chipGold}>₳{d.pool} pot</span>
              <span className={chip}>{d.entries} {d.entries === 1 ? "entry" : "entries"}</span>
              {s && <span className={chip}>closes in {closesIn(s.closes_in)}</span>}
              {frozen && <span className={chip}>final result</span>}
              {d.entered && <span className={cx(chip, "border-yin/50 bg-yin/10 font-semibold text-yin-light")}>you're in</span>}
              {d.payouts_live === false && !frozen && <span className={cx(chip, "text-ink-3")}>preview — pays from next new moon</span>}
            </div>
          </header>

          {!frozen && <EnterBlock d={d} onEntered={() => Api.detail(chKey).then(setD, () => {})} />}

          {/* The competition anatomy: Leaderboard · Discussion · Results. */}
          <div role="tablist" aria-label="Challenge sections" className="flex gap-1 overflow-x-auto border-b border-line">
            {([["board", "Leaderboard"], ["talk", "Discussion"], ["results", "Results"]] as [Tab, string][]).map(([t, label]) => (
              <button key={t} type="button" role="tab" aria-selected={showTab === t}
                onClick={() => { setTab(t); if (t !== "results" && season) setSeason(0); }}
                className={cx("min-h-[42px] shrink-0 border-b-2 px-3.5 text-[13.5px] font-semibold transition-colors",
                  showTab === t ? "border-yang text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>

          {showTab === "board" && (
            d.board.length === 0 ? (
              <EmptyState title="No entries yet" body={d.system ? `${KIND_META[d.kind].auto} Make one and it appears here.` : "Be the first to enter — the pot is waiting."} />
            ) : (
              <ul className="flex list-none flex-col divide-y divide-line/70 rounded-card border border-line bg-space-1/40">
                {d.board.map((e) => <BoardRow key={e.work_id} kind={d.kind} e={e} live={!frozen} />)}
              </ul>
            )
          )}

          {showTab === "talk" && (d.thread_id ? <Talk threadId={d.thread_id} /> : <p className="text-[13px] text-ink-3">No discussion board attached.</p>)}

          {showTab === "results" && (
            <div className="flex flex-col gap-3">
              {(d.seasons?.length ?? 0) > 0 && (
                <label className="flex items-center gap-2 text-[13px] text-ink-3">
                  Season
                  <select value={season} onChange={(e) => setSeason(Number(e.target.value))}
                    className="rounded border border-line bg-space-1 px-2 py-1.5 text-[13px] text-ink">
                    <option value={0}>Current (live)</option>
                    {d.seasons.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                </label>
              )}
              {frozen ? (
                d.board.length === 0 ? <EmptyState title="No result recorded" body="This season closed without a qualifying board." /> : (
                  <ul className="flex list-none flex-col divide-y divide-line/70 rounded-card border border-line bg-space-1/40">
                    {d.board.map((e) => <BoardRow key={e.work_id} kind={d.kind} e={e} live={false} />)}
                  </ul>
                )
              ) : (
                <p className="text-[13px] leading-relaxed text-ink-3">
                  Results freeze at the new moon{s ? ` (${s.ends_label})` : ""}: the top three split the pot 50/30/20,
                  every entrant keeps the season's certificate, and the board archives here forever.
                  {(d.seasons?.length ?? 0) === 0 && " No past seasons yet — this is the first."}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The one action a visitor needs: enter (or make the thing that auto-enters). */
function EnterBlock({ d, onEntered }: { d: ChallengeDetail; onEntered: () => void }) {
  const logged = isLoggedIn();
  const [workId, setWorkId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const meta = KIND_META[d.kind];
  if (!logged) {
    return <p className="text-[13px] text-ink-3"><a href={localePath("/login/")} className="font-semibold text-yin-light hover:underline">Sign in</a> to enter — anyone can heart the entries below.</p>;
  }
  if (d.system) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => { window.location.href = localePath(meta.enterHref); }}>{meta.enterLabel}</Button>
        <span className="text-[12.5px] text-ink-3">{meta.auto}</span>
      </div>
    );
  }
  const works = d.my_works ?? [];
  const enter = async () => {
    if (!workId) return setErr("Pick which of your works to enter.");
    setErr(""); setBusy(true);
    try { await Api.enterWork(d.id, workId); onEntered(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not enter"); }
    finally { setBusy(false); }
  };
  return (
    <Card className="flex flex-col gap-2 p-3">
      {works.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={workId} onChange={(e) => setWorkId(Number(e.target.value))} aria-label="Your work"
              className="min-w-0 flex-1 rounded-card border border-line bg-space-1 px-2.5 py-2 text-[14px] text-ink">
              <option value={0}>Pick your {meta.label.toLowerCase()}…</option>
              {works.map((w) => <option key={w.work_id} value={w.work_id}>{w.title}</option>)}
            </select>
            <Button onClick={enter} disabled={busy}>{busy ? "Entering…" : `Enter — ₳${d.enter_fee ?? 1}`}</Button>
          </div>
          <p className="text-[12px] text-ink-3">The fee joins the pot. Hearts your work already earned this season count here too.</p>
        </>
      ) : (
        <p className="text-[13px] text-ink-3">
          Enter with a {meta.label.toLowerCase()} you made this season —{" "}
          <a href={localePath(meta.enterHref)} className="font-semibold text-yin-light hover:underline">{meta.enterLabel.toLowerCase()} →</a>
        </p>
      )}
      {err && <StatusNote error>{err}</StatusNote>}
    </Card>
  );
}

function BoardRow({ kind, e, live }: { kind: ChallengeKind; e: ChallengeEntry; live: boolean }) {
  const me = currentUser()?.slug;
  const mine = !!me && e.author.slug === me;
  return (
    <li className="flex min-h-[56px] items-center gap-3 px-3 py-2">
      <span className="w-7 shrink-0 text-center text-[14px] font-bold tabular-nums text-ink-3">{e.rank <= 3 ? MEDAL[e.rank - 1] : e.rank}</span>
      {e.media
        ? <img src={e.media} alt="" loading="lazy" className="h-11 w-9 shrink-0 rounded object-cover" />
        : <span aria-hidden className="grid h-11 w-9 shrink-0 place-items-center rounded bg-space-2 text-ink-3"><HeartGlyph size={13} filled={false} /></span>}
      <span className="min-w-0 flex-1">
        <a href={localePath(e.url)} className="block truncate text-[14px] font-semibold text-ink no-underline hover:text-yin-light">{e.title || `${KIND_META[kind].label} #${e.work_id}`}</a>
        <span data-ay-skip="1" className="block truncate text-[12px] text-ink-3">{e.author.name}{e.prize > 0 && <span className="font-bold text-yang"> · ₳{e.prize}</span>}</span>
      </span>
      {live ? <EntryHeart kind={kind} e={e} mine={mine} /> : (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-bold tabular-nums text-ink-2"><HeartGlyph size={16} /> {e.hearts}</span>
      )}
    </li>
  );
}

function EntryHeart({ kind, e, mine }: { kind: ChallengeKind; e: ChallengeEntry; mine: boolean }) {
  const [hearts, setHearts] = useState(e.hearts);
  const [my, setMy] = useState(0);
  const [busy, setBusy] = useState(false);
  const logged = isLoggedIn();
  useEffect(() => {
    if (!logged || mine) return;
    Api.workHearts(kind, e.work_id).then((r) => setMy(r.my_vote), () => {});
  }, [kind, e.work_id, logged, mine]);
  if (!logged || mine) {
    return (
      <span className={cx("flex shrink-0 items-center gap-1.5 text-[13px] font-bold tabular-nums", mine ? "text-ink-3" : "text-ink-2")}
        title={mine ? "You can’t heart your own work" : "Sign in to heart this"}>
        <HeartGlyph size={16} /> {hearts}
      </span>
    );
  }
  const cast = async () => {
    if (busy) return;
    const want = my === 1 ? 0 : 1;
    const prev = { my, hearts };
    setBusy(true); setMy(want); setHearts((h) => h + (want === 1 ? 1 : -1));
    try { const r = await Api.heart(kind, e.work_id, want as 1 | 0); setMy(r.my_vote); setHearts(r.hearts); }
    catch { setMy(prev.my); setHearts(prev.hearts); }
    finally { setBusy(false); }
  };
  return (
    <button type="button" onClick={cast} disabled={busy} aria-pressed={my === 1} aria-label={my === 1 ? "Remove heart" : "Heart this work"}
      className={cx("flex min-h-[40px] shrink-0 touch-manipulation items-center gap-1.5 rounded-pill border px-3 py-1.5 text-[13px] font-bold tabular-nums transition-colors disabled:opacity-50",
        my === 1 ? "border-yang/50 bg-yang/15 text-yang" : "border-line text-ink-3 hover:border-yang/50 hover:text-ink")}>
      <HeartGlyph size={16} filled={my === 1} /> {hearts}
    </button>
  );
}

/* ═══════════════════════════ The inline talk ═══════════════════════════ */

type TalkComment = { id: number; parent: number; body: string; author: string; slug: string; avatar: string; mine: boolean; score: number; my_vote: number; at: number; deleted: boolean };

function Talk({ threadId }: { threadId: number }) {
  const [items, setItems] = useState<TalkComment[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const logged = isLoggedIn();
  const load = () => Social.thread(threadId).then((t) => setItems(((t.comments as TalkComment[]) ?? []).filter((c) => !c.parent)), () => setItems([]));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [threadId]);
  const send = async () => {
    const text = body.trim();
    if (text.length < 2) return;
    setBusy(true); setErr("");
    try { await Social.comment(threadId, text); setBody(""); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not post"); }
    finally { setBusy(false); }
  };
  return (
    <section className="flex flex-col gap-3">
      {logged ? (
        <div className="flex flex-col gap-2">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Say something — cheer an entry, ask a question…"
            className="w-full rounded-card border border-line bg-space-1 px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-yin/60 focus:outline-none" />
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={send} disabled={busy || body.trim().length < 2}>{busy ? "Posting…" : "Post"}</Button>
            {err && <span className="text-[12.5px] text-rose-400">{err}</span>}
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-ink-3"><a href={localePath("/login/")} className="font-semibold text-yin-light hover:underline">Sign in</a> to join the talk.</p>
      )}
      {items === null ? (
        <p className="text-[13px] text-ink-3">Loading the talk…</p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing yet — say the first word.</p>
      ) : (
        <ul className="flex list-none flex-col gap-3">
          {items.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <Avatar src={c.avatar} name={c.author} className="mt-0.5 h-8 w-8 shrink-0 text-[11px]" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink-3">
                  {c.slug ? <a data-ay-skip="1" href={localePath(`/u/${c.slug}/`)} className="font-semibold text-ink-2 no-underline hover:text-ink">{c.author}</a> : <span data-ay-skip="1" className="font-semibold text-ink-2">{c.author}</span>}
                  <span>{relAgo(c.at)}</span>
                </p>
                {/* Server-sanitised (wp_kses_post) — same trust as the Thread page. */}
                <div className="prose-sm mt-0.5 max-w-none text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: c.body }} />
              </div>
              <div className="shrink-0"><VotePill votes={c.score} target={String(c.id)} kind="comment" myVote={c.my_vote} mine={c.mine} /></div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12.5px] text-ink-3">
        Replies and the full record live on <a href={localePath(`/discussions/?thread=${threadId}`)} className="font-semibold text-yin-light hover:underline">the thread →</a>
      </p>
    </section>
  );
}

export default function ChallengesPage() {
  const { kind } = useParams<{ kind?: string }>();
  const key = (kind ?? "").toLowerCase();
  if (key && ((KINDS as string[]).includes(key) || /^\d+$/.test(key))) return <Detail chKey={key} />;
  return <Hub />;
}
