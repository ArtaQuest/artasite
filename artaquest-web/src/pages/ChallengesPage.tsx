/**
 * Challenges (member-founded challenges, 2026-07-14) — found one, grow the pool, take it all.
 * Category + sitewide topic + a full-moon deadline + your entry fee + your own notebook. Every
 * entrant pays the fee into the pool; at the moon the most-hearted entry wins everything (ties split).
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError, chCreate, chEnter, chOptions, getChallenge, listChallenges, myNotebooks,
  type Challenge, type CreditOffer, type NbKind, type NotebookCard, commodities, type Commodities,} from "../lib/api";
import { NB_KIND_META } from "../components/nbview";
import { Avatar, Button, Chip, cx, EmptyState, HeartGlyph, PageHero, SectionHeader } from "../components/ui";
import { CommoditiesCard } from "../components/commodities";
import { isLoggedIn } from "../lib/auth";
import { uiLocale } from "../lib/wp";

function moonLabel(ts: number) {
  return new Date(ts * 1000).toLocaleDateString(uiLocale(), { month: "long", day: "numeric" }) + " (full moon)";
}

function CreateTournament({ onCreated }: { onCreated: () => void }) {
  const [opts, setOpts] = useState<{ topics: string[]; moons: number[] } | null>(null);
  const [mine, setMine] = useState<NotebookCard[]>([]);
  const [kind, setKind] = useState<NbKind>("article");
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [moon, setMoon] = useState(0);
  const [fee, setFee] = useState(1);
  const [nbId, setNbId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    chOptions().then((o) => { setOpts(o); setMoon(o.moons[0]); setTopic(o.topics[0]); }).catch(() => {});
    myNotebooks().then((r) => setMine(r.items.filter((n) => n.status === "published"))).catch(() => {});
  }, []);
  if (!isLoggedIn()) return null;
  const eligible = mine.filter((n) => n.kind === kind);
  const go = () => {
    if (busy || !nbId || title.trim().length < 4) return;
    setBusy(true); setErr("");
    chCreate({ kind, topic, title: title.trim(), deadline: moon, fee, nb_id: nbId })
      .then(() => { setTitle(""); onCreated(); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not create"))
      .finally(() => setBusy(false));
  };
  return (
    <details className="rounded-2xl border border-line bg-space-2">
      <summary className="cursor-pointer list-none px-5 py-4 text-[15px] font-bold text-yang">＋ Found a challenge</summary>
      <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(NB_KIND_META) as NbKind[]).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => { setKind(k); setNbId(0); }}>{NB_KIND_META[k].label}</Chip>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[13px] text-ink-3">Topic
            <select value={topic} onChange={(e) => setTopic(e.currentTarget.value)}
              className="mt-1 w-full rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink">
              {(opts?.topics || []).map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-[13px] text-ink-3">Deadline
            <select value={moon} onChange={(e) => setMoon(Number(e.currentTarget.value))}
              className="mt-1 w-full rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink">
              {(opts?.moons || []).map((m) => <option key={m} value={m}>{moonLabel(m)}</option>)}
            </select>
          </label>
        </div>
        <input value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={160}
          placeholder="Challenge title — what should people make?"
          className="w-full rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink outline-none focus:border-yin-ink" />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[13px] text-ink-3">Entry fee in Arta Coin (₳) — you pay it too
            <input type="number" min={1} max={1000} value={fee} onChange={(e) => setFee(Math.max(1, Math.min(1000, Number(e.currentTarget.value) || 1)))}
              className="mt-1 w-full rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink" />
          </label>
          <label className="text-[13px] text-ink-3">Your entry (a published {NB_KIND_META[kind].label.toLowerCase()} of yours)
            <select value={nbId} onChange={(e) => setNbId(Number(e.currentTarget.value))}
              className="mt-1 w-full rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink">
              <option value={0}>Choose…</option>
              {eligible.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[12px] text-ink-3">Winner takes the pool at the full moon.</p>
          <Button size="sm" className="ml-auto shrink-0" onClick={go} disabled={busy || !nbId || title.trim().length < 4}>
            {busy ? "Founding…" : `Found it (₳${fee})`}
          </Button>
        </div>
        {err ? <p className="text-[12px] text-ink-2">{err}</p> : null}
        {!eligible.length ? <p className="text-[12px] text-ink-3">No published notebook of this kind yet — <Link className="text-yin-ink hover:underline" to="/studio">make one in the Studio</Link>; a work enters once you have published it from your own inbox.</p> : null}
      </div>
    </details>
  );
}

function Board({ id }: { id: number }) {
  const [c, setC] = useState<Challenge | null>(null);
  const [mine, setMine] = useState<NotebookCard[]>([]);
  const [nbId, setNbId] = useState(0);
  const [note, setNote] = useState("");
  const [offer, setOffer] = useState<CreditOffer | null>(null);
  const [certUrl, setCertUrl] = useState("");
  // A swallowed rejection left `c` null forever, and the null branch below is the loading skeleton —
  // so a failed board pulsed indefinitely, said nothing, offered no retry, and (aria-hidden) announced
  // nothing at all to a screen reader. Reloading was the only way out and looked identical.
  const [loadErr, setLoadErr] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setLoadErr(false);
    getChallenge(id).then((r) => { setC(r); setLoadErr(false); }).catch(() => setLoadErr(true));
    if (isLoggedIn()) myNotebooks().then((r) => setMine(r.items.filter((n) => n.status === "published"))).catch(() => {});
  }, [id, tick]);
  if (!c && loadErr) {
    return (
      <div className="rounded-2xl border border-line bg-space-2 p-4">
        <p className="text-[13px] text-ink-2">Couldn't load this challenge board.</p>
        <button type="button" onClick={() => setTick((n) => n + 1)}
          className="mt-2 rounded-pill border border-line px-3 py-1 text-[12px] text-ink transition-colors hover:border-yin-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yang/60">
          Try again
        </button>
      </div>
    );
  }
  if (!c) return <div className="h-40 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />;
  const eligible = mine.filter((n) => n.kind === c.kind);
  // ARTACREDITS: when the member is short the fee and a donor's gift matches them, the backend
  // REFUSES the first call with `credit_offered` and the donor's name. We show that, and only a
  // deliberate second click accepts — a stranger's gift is never spent on someone silently.
  const join = (acceptCredit = false) => {
    if (!nbId) return;
    setNote("");
    chEnter(c.id, nbId, acceptCredit)
      .then((r) => {
        setOffer(null);
        setNote(r.credited
          ? `You're in — ${r.credited.donor} paid your ₳${r.credited.fee} entry fee. Your certificate names them.`
          : `You're in — the pool is ₳${r.pool}.`);
        setCertUrl(r.certificate || "");
        return getChallenge(id).then(setC);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.code === "credit_offered") {
          setOffer((e.data as { credit?: CreditOffer }).credit || null);
          return;
        }
        setNote(e instanceof Error ? e.message : "Could not enter");
      });
  };
  return (
    <div className="rounded-2xl border border-line bg-space-2 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[16px] font-extrabold text-ink">{c.title}</h3>
        <span className="text-[12px] uppercase tracking-wider text-ink-3">{NB_KIND_META[c.kind]?.label} · {c.topic} · closes {moonLabel(c.deadline)}</span>
        <span className="ml-auto text-xl font-extrabold text-yang">₳{c.pool}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
        <Avatar name={c.creator.name} src={c.creator.avatar} className="h-4 w-4 text-[8px]" /> founded by {c.creator.name} · ₳{c.fee} to enter · winner takes all
      </p>
      <ol className="mt-3 flex list-none flex-col gap-1.5 p-0">
        {(c.board || []).map((b) => (
          <li key={b.nb_id}>
            <Link to={`/nb/${b.nb_id}/${b.slug}`} className={cx("flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors hover:border-yin-ink", b.rank === 1 ? "border-yang/60 bg-yang/[0.07]" : "border-line")}>
              <span className={cx("w-5 text-center text-sm font-extrabold", b.rank === 1 ? "text-yang" : "text-ink-3")}>{b.rank}</span>
              <Avatar name={b.author.name} src={b.author.avatar} className="h-5 w-5 text-[9px]" />
              <span className="min-w-0 truncate text-[14px] text-ink-2">{b.title}</span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] text-ink-3"><HeartGlyph size={11} /> {b.hearts}</span>
            </Link>
          </li>
        ))}
      </ol>
      {isLoggedIn() && c.state === "open" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <select value={nbId} onChange={(e) => setNbId(Number(e.currentTarget.value))}
            className="min-w-0 flex-1 rounded-field border border-line bg-space-1 px-3 py-2 text-sm text-ink">
            <option value={0}>Enter with your {NB_KIND_META[c.kind]?.label.toLowerCase()}…</option>
            {eligible.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          </select>
          <Button size="sm" onClick={() => join()} disabled={!nbId}>Enter (₳{c.fee})</Button>
          {note ? (
            <p className="w-full text-[12px] text-yang-ink">
              {note}
              {certUrl ? <> <Link to={certUrl} className="font-semibold underline-offset-2 hover:underline">See your certificate</Link></> : null}
            </p>
          ) : null}
          {offer ? (
            <div className="w-full rounded-xl border border-yang/40 bg-yang/[0.07] p-3.5">
              <p className="text-[13.5px] leading-relaxed text-ink">
                <span className="font-semibold" data-ay-skip={offer.named ? "1" : undefined}>{offer.donor}</span> has already paid an
                entry fee for {offer.slice}. Accept it and you're in for ₳0 — their name goes on your Certificate of Participation.
              </p>
              <p className="mt-1.5 text-[12px] text-ink-3">{offer.notice}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => join(true)}>Accept and enter</Button>
                <Button size="sm" variant="outline" onClick={() => { setOffer(null); setNote("No problem — nothing was accepted."); }}>No thanks</Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function ChallengesPage() {
  const nav = useNavigate();
  const [current, setCurrent] = useState<Challenge[] | null>(null);
  const [past, setPast] = useState<Challenge[]>([]);
  const [openId, setOpenId] = useState(0);
  const [comm, setComm] = useState<Commodities | null>(null);
  const load = () => listChallenges().then((r) => {
    setCurrent([...r.current].sort((a, b) => a.deadline - b.deadline));
    setPast(r.past);
    setOpenId((cur) => cur || r.current[0]?.id || 0);
  }).catch(() => setCurrent([]));
  useEffect(() => { load(); }, []);
  // The price of energy lives HERE now (operator 2026-07-28): a prize pool is denominated in
  // gold-backed coin, and what that coin BUYS is the only thing that makes a pool figure mean
  // anything. It sat in the feed rail, where it was just a number beside somebody's post.
  useEffect(() => { commodities().then(setComm).catch(() => setComm(null)); }, []);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 py-6">
      <PageHero
        title="Challenges"
        lede="Member-made challenges: pick a topic, a full-moon deadline and an entry fee, open with your own notebook. Every entry grows the pool; most hearts takes it all (ties split)."
        aside={isLoggedIn() ? <Button onClick={() => nav("/studio")}>Prepare an entry</Button> : <Button href="/login/">Join to compete</Button>}
      />
      <CreateTournament onCreated={load} />
      <section className="flex flex-col gap-3">
        <SectionHeader title="Open challenges" />
        {current === null ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-veil/[0.06]" />)}
          </div>
        ) : current.length ? (
          <>
            <div className="flex flex-wrap gap-2">
              {current.map((c) => (
                <Chip key={c.id} active={openId === c.id} onClick={() => setOpenId(c.id)}>{c.title} · ₳{c.pool}</Chip>
              ))}
            </div>
            {openId ? <Board id={openId} /> : null}
          </>
        ) : (
          <EmptyState title="No open challenges" body="Found the first one — your fee starts the pool, and every entrant grows it." />
        )}
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader title="What a pool is worth" />
        <p className="max-w-2xl text-[14px] leading-relaxed text-ink-2">
          Pools are held in Arta Coin, which is gold-backed — one coin is one milligram. These are the
          fuels that set what a coin buys, all on one scale, so you can see what a prize is actually
          worth rather than just how large the number is.
        </p>
        <div className="max-w-md"><CommoditiesCard data={comm} /></div>
      </section>

      {past.length ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Settled at past moons" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((c) => (
              <div key={c.id} className="rounded-2xl border border-line bg-space-2 p-4">
                <h3 className="truncate text-sm font-bold text-ink">{c.title}</h3>
                <p className="text-[11px] uppercase tracking-wider text-ink-3">{NB_KIND_META[c.kind]?.label} · {c.topic}</p>
                {(c.results?.podium || []).slice(0, 1).map((w) => (
                  <p key={w.nb_id} className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
                    <Avatar name={w.author.name} src={w.author.avatar} className="h-5 w-5 text-[9px]" />
                    <span className="truncate">{w.author.name}</span>
                    <span className="ml-auto font-extrabold text-yang">₳{w.prize}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
