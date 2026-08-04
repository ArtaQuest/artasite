/**
 * Rankings (member-founded challenges, 2026-07-14) — live standings of every open challenge: each
 * board ranked by hearts, winner-takes-all at its full moon.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getChallenge, listChallenges, type Challenge } from "../lib/api";
import { NB_KIND_META } from "../components/nbview";
import { Avatar, Button, Chip, cx, EmptyState, HeartGlyph, PageHero } from "../components/ui";
import { isLoggedIn } from "../lib/auth";

function closesIn(ts: number) {
  const s = Math.max(0, ts - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400);
  return d >= 2 ? `${d} days` : `${Math.max(1, Math.floor(s / 3600))}h`;
}

export default function Rankings() {
  const nav = useNavigate();
  const [open, setOpen] = useState<Challenge[] | null>(null);
  const [sel, setSel] = useState(0);
  const [board, setBoard] = useState<Challenge | null>(null);
  useEffect(() => {
    listChallenges().then((r) => {
      const cur = [...r.current].sort((a, b) => b.pool - a.pool);
      setOpen(cur); setSel(cur[0]?.id || 0);
    }).catch(() => setOpen([]));
  }, []);
  useEffect(() => { if (sel) { setBoard(null); getChallenge(sel).then(setBoard).catch(() => {}); } }, [sel]);
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6">
      <PageHero
        title="Rankings"
        lede="Live standings, challenge by challenge. Top entry at the full moon takes the pool."
        aside={isLoggedIn() ? <Button onClick={() => nav("/challenges")}>Enter a challenge</Button> : <Button href="/login/">Join to compete</Button>}
      />
      {open === null ? (
        <div className="h-40 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />
      ) : open.length ? (
        <>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {open.map((c) => <Chip key={c.id} active={sel === c.id} onClick={() => setSel(c.id)}>{c.title} · ₳{c.pool}</Chip>)}
          </div>
          {board ? (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-lg font-extrabold tracking-tight">{board.title}</h2>
                <span className="text-2xl font-extrabold text-yang">₳{board.pool}</span>
                <span className="text-[13px] text-ink-3">{NB_KIND_META[board.kind]?.label} · {board.topic} · closes in {closesIn(board.deadline)} · winner takes all</span>
              </div>
              <ol className="flex list-none flex-col gap-2 p-0">
                {(board.board || []).map((e) => (
                  <li key={e.nb_id}>
                    <Link to={`/nb/${e.nb_id}/${e.slug}`}
                      className={cx("flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors hover:border-yin-ink",
                        e.rank === 1 ? "border-yang/60 bg-yang/[0.07]" : "border-line bg-space-2")}>
                      <span className={cx("w-8 shrink-0 text-center text-lg font-extrabold", e.rank === 1 ? "text-yang" : "text-ink-3")}>{e.rank}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-ink">{e.title}</p>
                        <p className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
                          <Avatar name={e.author.name} src={e.author.avatar} className="h-[18px] w-[18px] text-[8px]" />
                          <span className="truncate">{e.author.name}</span>
                        </p>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-ink-2"><HeartGlyph size={14} /> {e.hearts}</span>
                      <span className={cx("w-16 shrink-0 text-right text-sm font-extrabold", e.rank === 1 ? "text-yang-ink" : "text-ink-3")}>
                        {e.rank === 1 ? `₳${board.pool}` : "—"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ) : <div className="h-40 animate-pulse rounded-2xl bg-veil/[0.06]" aria-hidden />}
        </>
      ) : (
        <EmptyState title="No open challenges yet" body={<span>Standings appear the moment someone <Link className="text-yin-ink hover:underline" to="/challenges">founds one</Link>.</span>} />
      )}
    </main>
  );
}
