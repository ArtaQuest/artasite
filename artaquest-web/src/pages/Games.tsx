/**
 * ArtaRPS — one wheel, twelve tools, thrown all at once.
 *
 * Chess.com-shaped digital arena: lobby + auto-pairing, Elo leaderboard, live board with a
 * simultaneous-reveal HAND ANIMATION (snap to fist → pump → reveal — components/Hand.tsx),
 * match chat, resign / idle-claim, practice bots. Each round both players throw one of their
 * UNSPENT tools; two or four steps apart pays BOTH (+2/+3), three steps is the one duel
 * (+2/−2 — the Twelve Laws name every duel: "Saw cuts the Plow"), everything else costs both
 * −2. Twelve rounds, every tool exactly once, highest total takes the match — the margin is
 * made entirely of duels. Text is plain English — the i18n engine translates at runtime; the
 * twelve law lines carry seeded authored translations in the 20 selector languages.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  rpsBoard, rpsCreate, rpsJoin, rpsState, rpsMove, rpsChat, rpsClaim, rpsResign,
  type RpsBoard, type RpsMatch, type RpsMode, type RpsPlayer, type RpsRound, type RpsGameId,
} from "../lib/api";
import { isLoggedIn } from "../lib/api";
import { localePath } from "../lib/wp";
import { HandDefs, HandGlyph, HandLive, HandThrow } from "../components/Hand";
import { LAWS, TOOL_KEYS, TOOL_NAME, type ToolKey } from "../lib/hands";
import { Avatar, Button, Card, EmptyState, MetricChip, PageHero, Pill, SignInGate, StatusNote, Tabs, cx } from "../components/ui";

const IDX = Object.fromEntries(TOOL_KEYS.map((k, i) => [k, i])) as Record<ToolKey, number>;
const idx = (t: string) => IDX[t as ToolKey] ?? 0;

/* THE THREE GAMES — a difficulty ladder by board size (the only tool-subsets with real duels are
 * 4, 8 and 12). All hand-tools + the Twelve Laws, no astrology. Each is its own catalogue card and
 * its own page (/game/<slug>); all share the lobby/Elo/chat/clock engine. */
type GameId = RpsGameId;
const RING4: ToolKey[] = ["gun", "cup", "wedge", "rock"];
const CROSS8: ToolKey[] = ["gun", "cup", "wedge", "rock", "plow", "bolt", "hook", "saw"];
const GAME_TOOLS: Record<GameId, ToolKey[]> = { ring: RING4, cross: CROSS8, wheel: [...TOOL_KEYS] };
type GameDef = { id: GameId; slug: string; title: string; tagline: string; level: string; blurb: string; rounds: number };
const GAMES: GameDef[] = [
  { id: "ring", slug: "ring", title: "The Ring", tagline: "One duel cycle", level: "Beginner", rounds: 4,
    blurb: "Four tools, four rounds — the quickest way in. Each tool takes the next around the ring; learn the feel in a minute." },
  { id: "cross", slug: "cross", title: "The Cross", tagline: "Two rings interlocked", level: "Intermediate", rounds: 8,
    blurb: "Eight tools, eight rounds — now alliances and duels criss-cross two rings at once, and reading your rival starts to pay." },
  { id: "wheel", slug: "wheel", title: "The Wheel", tagline: "Every tool once", level: "Advanced", rounds: 12,
    blurb: "All twelve, twelve rounds — the full game. The Twelve Laws decide every duel, and the margin is built entirely in them." },
];
const GAME_BY_ID: Record<GameId, GameDef> = Object.fromEntries(GAMES.map((g) => [g.id, g])) as Record<GameId, GameDef>;
/** URL slug → game (the deck's QR and old links use /game/artarps → the wheel). */
const gameFromSlug = (slug?: string): GameId | null =>
  slug === "ring" || slug === "cross" || slug === "wheel" ? slug : slug === "artarps" ? "wheel" : null;
/** Legacy per-ring match keys still render (old live matches created before the ladder). */
const LEGACY: Record<string, ToolKey[]> = {
  gun: RING4, cardinal: RING4, plow: ["plow", "bolt", "hook", "saw"], scissors: ["scissors", "wheat", "arrow", "net"],
};
const arenaOf = (key: string): ToolKey[] => GAME_TOOLS[key as GameId] ?? LEGACY[key] ?? [...TOOL_KEYS];
const gameTitle = (key: string): string => GAME_BY_ID[key as GameId]?.title ?? "The Wheel";

/** mm:ss for the clock. */
const clockFmt = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
};

/* Scores can go negative (a clash is −2 both), so format with a real minus (U+2212) and a clean
 * separator — the old `{a}–{b}` rendered "8–-8" (en-dash then hyphen) as the mangled "8--8". */
const MINUS = "−";
const sc = (n: number) => (n < 0 ? MINUS + Math.abs(n) : String(n));
const scoreLine = (a: number, b: number) => sc(a) + ' : ' + sc(b);

/* ── the masthead: one game, spoken as a living duel ────────────────────────── */
function Masthead({ compact, game }: { compact?: boolean; game?: GameDef }) {
  // `k` is the current duel; a fresh throw is picked in the event/effect (never Math.random in render,
  // which is impure and re-rolls on any incidental re-render). `roll` keys the throw animations.
  const [k, setK] = useState(0);
  const [roll, setRoll] = useState(0);
  const [spoken, setSpoken] = useState(false);
  // draw the duel from THIS game's tools so the hero speaks the game you're on
  const pool = game ? GAME_TOOLS[game.id] : ([...TOOL_KEYS] as ToolKey[]);
  const mineTool = pool[k % pool.length];
  const mineIdx = IDX[mineTool];
  const theirs = TOOL_KEYS[(mineIdx + 3) % 12];
  const rethrow = () => { setK((prev) => prev + 1 + Math.floor(Math.random() * 5)); setRoll((r) => r + 1); };
  useEffect(() => { rethrow(); }, []); // seed the opening duel on mount (rethrow is stable enough for a one-shot)
  useEffect(() => {
    setSpoken(false);
    const t = setTimeout(() => setSpoken(true), 1500);   // backstop past the ~0.9s throw
    return () => clearTimeout(t);
  }, [roll]);
  return (
    <header className={cx("relative overflow-hidden rounded-card border border-line", compact ? "mb-4 px-4 py-3" : "mb-2 px-5 py-6 sm:py-8")}
      style={{ background: "radial-gradient(60% 90% at 18% 30%, rgba(232,185,35,.10), transparent 65%), radial-gradient(60% 90% at 82% 70%, rgba(23,70,220,.14), transparent 65%)" }}>
      <div role="button" tabIndex={0} aria-label="Throw a new duel"
        onClick={rethrow} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rethrow(); } }}
        className="mx-auto flex max-w-[620px] cursor-pointer select-none items-center justify-center gap-4 outline-none sm:gap-8">
        <HandThrow key={`a${roll}`} tool={mineTool} width={compact ? 84 : 132} pumps={1} onRevealed={() => setSpoken(true)}
          className={cx(compact ? "w-[72px] sm:w-[84px]" : "w-[min(132px,26vw)]")} />
        <div className="text-center">
          {game && <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-yang">ArtaRPS</p>}
          <h1 className={cx("font-black tracking-tight text-ink", game ? "" : "", compact ? "text-[24px] leading-tight" : "text-[38px] leading-none sm:text-[46px]", game ? "" : "")}>
            {game ? game.title : <>Arta<span className="text-yang">RPS</span></>}
          </h1>
          <p className={cx("inline-block rounded-pill px-2.5 font-semibold transition-colors", compact ? "mt-1 py-0.5 text-[12px]" : "mt-2.5 py-1 text-[15px]", spoken ? "bg-yang/10 text-yang" : "text-ink-3")} aria-live="polite">
            {spoken ? LAWS[mineIdx] : "…"}
          </p>
          {!compact && <p className="mx-auto mt-2.5 max-w-[44ch] text-[13px] leading-relaxed text-ink-3">{game ? game.blurb : "Rock–paper–scissors, grown to twelve. Tap the hands for a fresh duel."}</p>}
        </div>
        <HandThrow key={`b${roll}`} tool={theirs} width={compact ? 84 : 132} pumps={1} blue mirror
          className={cx(compact ? "w-[72px] sm:w-[84px]" : "w-[min(132px,26vw)]")} />
      </div>
    </header>
  );
}

/* ── small bits ─────────────────────────────────────────────────────────────── */
function RatingPill({ p }: { p: RpsPlayer }) {
  return <MetricChip tone="gold" title="Elo rating">♟ {p.rating}</MetricChip>;
}
/** A chess.com-style clock: mono mm:ss; the ticking side is lit, the last minute pulses red. */
function ClockChip({ seconds, running, show }: { seconds: number; running: boolean; show: boolean }) {
  if (!show) return null;
  const low = seconds <= 60;
  return (
    <span aria-label="Time remaining" title="Time on the clock"
      className={cx("min-w-[4.5ch] rounded-md px-2 py-1 text-center font-mono text-[16px] font-bold tabular-nums transition-colors",
        running ? (low ? "bg-red-500/15 text-red-400 motion-safe:animate-pulse" : "bg-yang/15 text-yang ring-1 ring-yang/40")
                : (low ? "text-red-400/70" : "border border-line text-ink-3"))}>
      {clockFmt(seconds)}
    </span>
  );
}
function PlayerBar({ p, score, you, pending, clock, running, showClock }: {
  p: RpsPlayer | null; score: number; you: boolean; pending: boolean; clock: number; running: boolean; showClock: boolean;
}) {
  return (
    <div className={cx("flex items-center gap-3 rounded-card border px-3.5 py-2.5", running ? "border-yang/40 bg-yang/[0.04]" : "border-line bg-veil/[0.04]")}>
      <Avatar name={p ? p.name : "ArtaBot"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-bold">
          {p && p.slug ? <a className="hover:underline" href={`/u/${p.slug}`}>{p.name}</a> : (p ? p.name : "ArtaBot")}
          {you && <span className="ml-2 rounded-pill bg-yin/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-yin-light">you</span>}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">{p ? `${p.wins}W · ${p.losses}L · ${p.draws}D` : "practice partner"}{pending && <span className="ml-2 text-yang">✦ sealed a throw</span>}</p>
      </div>
      {p && <RatingPill p={p} />}
      <ClockChip seconds={clock} running={running} show={showClock} />
      <span className={cx("min-w-[3ch] text-right text-[26px] font-extrabold tabular-nums", score < 0 ? "text-yin-light" : "text-ink")}>{sc(score)}</span>
    </div>
  );
}

/* ── the reveal stage: fists pump, hands land, a law is spoken, then it clears ── */
function RevealStage({ round, mineIsA, onDone }: { round: RpsRound; mineIsA: boolean; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  // onDone is an inline callback that changes on every parent render (the 1s clock re-renders the
  // board). Read it from a ref so the dismiss timer — keyed on the round only — is NEVER reset by a
  // re-render; before the fix the overlay never cleared and the wheel stayed covered (and the clock
  // ran down to a flag). Tapping the overlay also dismisses it, so you can rush to the next throw.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const dismiss = useCallback(() => doneRef.current(), []);
  const mine = (mineIsA ? round.a : round.b) as ToolKey;
  const theirs = (mineIsA ? round.b : round.a) as ToolKey;
  const pm = mineIsA ? round.pa : round.pb;
  const pt = mineIsA ? round.pb : round.pa;
  useEffect(() => {
    // One lifecycle per round: land the hands (the ~1.2s throw; 2.4s backstop for rAF-frozen tabs),
    // hold the verdict, then auto-dismiss at 4.6s. Fixed timers on round.r only — re-render safe.
    setShown(false);
    const showT = setTimeout(() => setShown(true), 2400);
    const doneT = setTimeout(dismiss, 4600);
    return () => { clearTimeout(showT); clearTimeout(doneT); };
  }, [round.r, dismiss]);
  const verdict = pm === pt ? (pm > 0 ? "Both rise" : "Both fall") : LAWS[idx(pm > pt ? mine : theirs)];
  const tone = pm > 0 ? "text-yang" : pm < 0 && pt < 0 ? "text-yin-light" : pm > pt ? "text-yang" : "text-yin-light";
  return (
    <div role="button" tabIndex={0} aria-label={`Round ${round.r}: ${TOOL_NAME[mine]} versus ${TOOL_NAME[theirs]} — tap to continue`}
      onClick={dismiss} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " " || e.key === "Escape") { e.preventDefault(); dismiss(); } }}
      className="absolute inset-0 z-20 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-card bg-space-1/90 backdrop-blur-[2px] outline-none">
      <div className="flex w-full max-w-[560px] items-center justify-center gap-3 px-4 sm:gap-6">
        <div className="relative flex min-w-0 flex-1 flex-col items-center">
          {shown && pm > pt && <div aria-hidden className="absolute inset-[-12%] rounded-full bg-yang/20 blur-2xl" />}
          <HandThrow tool={mine} width={150} pumps={2} onRevealed={() => setShown(true)} className="relative w-[min(150px,34vw)]" />
          <span className={cx("relative mt-1 text-[16px] font-extrabold tabular-nums", pm >= 0 ? "text-yang" : "text-yin-light")}>
            {shown ? (pm > 0 ? `+${pm}` : sc(pm)) : " "}
          </span>
          <span className="relative text-[11px] font-bold text-ink-3">{shown ? TOOL_NAME[mine] : " "}</span>
        </div>
        <div className="w-[120px] shrink-0 text-center sm:w-[150px]">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-ink-3">round {round.r}</p>
          {shown && <p className={cx("mt-1 text-[15.5px] font-extrabold leading-snug", tone)}>{verdict}</p>}
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col items-center">
          {shown && pt > pm && <div aria-hidden className="absolute inset-[-12%] rounded-full bg-yin/15 blur-2xl" />}
          <HandThrow tool={theirs} width={150} pumps={2} blue mirror className="relative w-[min(150px,34vw)]" />
          <span className={cx("relative mt-1 text-[16px] font-extrabold tabular-nums", pt >= 0 ? "text-yang" : "text-yin-light")}>
            {shown ? (pt > 0 ? `+${pt}` : sc(pt)) : " "}
          </span>
          <span className="relative text-[11px] font-bold text-ink-3">{shown ? TOOL_NAME[theirs] : " "}</span>
        </div>
      </div>
      {shown && <p className="text-[11.5px] font-semibold uppercase tracking-[0.18em] text-ink-3">Tap to continue →</p>}
    </div>
  );
}

/* ── THE WHEEL DIAL — the signature illustration ─────────────────────────────────
 * The twelve tools sit at the twelve vertices; the game's whole structure is drawn behind
 * them. Each ring is a SQUARE inscribed in the twelve-gon (positions {0,3,6,9}, {1,4,7,10},
 * {2,5,8,11}), and inside a ring every tool takes the NEXT vertex — so the "beats" relations
 * ARE the three squares' edges. We draw them as faint bowed chords (the whole doctrine at a
 * glance), a gold→blue hub vignette, and a ticked outer dial. In play, hovering a tool lights
 * the gold arc to the tool it takes; the sealed throw pulses; spent tools dim with a tick.
 * One component serves the hub showcase (living hover-throw hands) and the match board (buttons). */
function WheelDial({ arena, interactive = false, used, sealed = null, disabled = false, onThrow, center }: {
  arena: ToolKey[]; interactive?: boolean; used?: Set<string>; sealed?: string | null;
  disabled?: boolean; onThrow?: (tool: string) => void; center?: ReactNode;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const n = arena.length;
  const easy = n < 12;
  const step = 360 / n;
  const offset = easy ? 1 : 3;           // "beats" reaches the next square-vertex: +1 in a 4-ring, +3 on the wheel
  const R = easy ? 34 : 41;              // hand-ring radius (%)
  const bow = easy ? 0.72 : 0.6;         // pull each chord's midpoint toward centre → nested rosette
  const pos = (i: number) => {
    const a = (i * step - 90) * (Math.PI / 180);
    return [50 + R * Math.cos(a), 50 + R * Math.sin(a)] as const;
  };
  const chord = (i: number) => {
    const [x1, y1] = pos(i), [x2, y2] = pos((i + offset) % n);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const cx = 50 + (mx - 50) * bow, cy = 50 + (my - 50) * bow;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} Q${cx.toFixed(2)} ${cy.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const gold = easy;                     // a lone ring reads gold; the full wheel keeps its chords neutral
  const prey = hover != null ? (hover + offset) % n : null;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[440px]" role="group" aria-label="The wheel of tools">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        <defs>
          <radialGradient id={`hub${id}`} cx="38%" cy="34%" r="72%">
            <stop offset="0" stopColor="var(--color-yang)" stopOpacity="0.18" />
            <stop offset="52%" stopColor="var(--color-yin)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--color-yin)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* hub vignette + its rim (the only full ring — a big outer circle fought the hand labels) */}
        <circle cx="50" cy="50" r="24" fill={`url(#hub${id})`} />
        <circle cx="50" cy="50" r="24" fill="none" stroke="var(--color-line)" strokeWidth="0.4" strokeOpacity="0.8" />
        {/* the outer dial reads as ticks alone, sitting just past the hands */}
        {arena.map((_, i) => {
          const a = (i * step - 90) * (Math.PI / 180);
          const r0 = R + 5.5, r1 = R + 7.5;
          return <line key={i} x1={(50 + r0 * Math.cos(a)).toFixed(2)} y1={(50 + r0 * Math.sin(a)).toFixed(2)}
            x2={(50 + r1 * Math.cos(a)).toFixed(2)} y2={(50 + r1 * Math.sin(a)).toFixed(2)}
            stroke="var(--color-line)" strokeWidth="0.6" strokeLinecap="round" />;
        })}
        {/* the structure: every tool → the tool it takes (the three inscribed squares / the ring) */}
        {arena.map((_, i) => (
          <path key={i} d={chord(i)} fill="none" strokeLinecap="round"
            stroke={gold ? "var(--color-yang)" : "var(--color-line)"}
            strokeOpacity={gold ? 0.55 : 0.7} strokeWidth={gold ? 0.75 : 0.55} />
        ))}
        {/* live "takes" arc on hover: a soft gold glow under a crisp arc, ending in a ring on the prey */}
        {interactive && hover != null && prey != null && (
          <>
            <path d={chord(hover)} fill="none" stroke="var(--color-yang)" strokeOpacity="0.28" strokeWidth="3" strokeLinecap="round" />
            <path d={chord(hover)} fill="none" stroke="var(--color-yang)" strokeOpacity="1" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx={pos(prey)[0].toFixed(2)} cy={pos(prey)[1].toFixed(2)} r="2.4" fill="none" stroke="var(--color-yang)" strokeWidth="1" />
            <circle cx={pos(prey)[0].toFixed(2)} cy={pos(prey)[1].toFixed(2)} r="1.1" fill="var(--color-yang)" />
          </>
        )}
      </svg>

      {arena.map((t, i) => {
        const k = IDX[t];
        const [x, y] = pos(i);
        const spent = !!used?.has(t);
        const sealedThis = sealed === t;
        const live = !interactive;
        const dead = interactive && (disabled || spent);
        const common = { style: { left: `${x}%`, top: `${y}%` } } as const;
        const label = <span className={cx("mt-0.5 text-[10.5px] font-bold leading-none", spent ? "text-ink-3" : "text-ink-2")}>{TOOL_NAME[t]}</span>;
        if (live) {
          return (
            <span key={t} className="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" {...common}
              title={`${TOOL_NAME[t]} — ${LAWS[k]}`}>
              <HandLive tool={t} width={easy ? 54 : 40} />
              {label}
            </span>
          );
        }
        return (
          <button key={t} onClick={() => onThrow?.(t)} disabled={dead}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onFocus={() => setHover(i)} onBlur={() => setHover((h) => (h === i ? null : h))}
            title={`${TOOL_NAME[t]} — ${LAWS[k]} · but ${LAWS[(k + 9) % 12]}`}
            className={cx(
              "group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-card px-1 pb-1 pt-1.5 transition-all duration-150",
              easy ? "w-[86px]" : "w-[70px]",
              !dead && "hover:z-10 hover:bg-yang/10 hover:ring-1 hover:ring-yang/40",
              sealedThis && "z-10 bg-yang/15 ring-1 ring-yang motion-safe:animate-pulse",
              spent && "opacity-30",
            )}
            {...common}>
            <span className="relative">
              <HandGlyph tool={t} width={easy ? 54 : 44} className={cx("transition-transform duration-150", !dead && "group-hover:-translate-y-1 group-hover:scale-110")} />
              {spent && <span aria-hidden className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-ink-4 text-[8px] font-black text-on-accent">✓</span>}
            </span>
            {label}
          </button>
        );
      })}

      <div className="pointer-events-none absolute left-1/2 top-1/2 flex w-[44%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
        {center}
      </div>
    </div>
  );
}

/** The centre of the throwing dial: the round counter as a dial. */
function RoundHub({ label, roundNo, total }: { label: string; roundNo: number; total: number }) {
  return (
    <>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-3">{label}</p>
      <p className="mt-0.5 text-[32px] font-black leading-none tabular-nums text-ink">{Math.min(roundNo, total)}<span className="text-[15px] font-bold text-ink-3"> / {total}</span></p>
      <p className="mt-0.5 text-[10.5px] leading-snug text-ink-3">every tool once</p>
    </>
  );
}

/* ── the match board ────────────────────────────────────────────────────────── */
function MatchBoard({ match, onExit, onRematch }: { match: RpsMatch; onExit: () => void; onRematch: (mode: RpsMode, game: string) => void }) {
  const [m, setM] = useState<RpsMatch>(match);
  const [chat, setChat] = useState(match.chat ?? []);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [reveal, setReveal] = useState<RpsRound | null>(null);
  const [sealedTool, setSealedTool] = useState<string | null>(null);
  // clock: server sends the banks + which seat ticks + its own clock; we count the running bank down
  // locally between the 2.5s polls (the server is always the source of truth — the flag happens there).
  const clock = useRef({ base: (match.clock ?? [match.clock_s ?? 600, match.clock_s ?? 600]) as [number, number], at: 0, run: (match.clock_run ?? [false, false]) as [boolean, boolean], show: (match.clock_s ?? 0) > 0 });
  const seenRounds = useRef(match.rounds.length);
  const chatEnd = useRef<HTMLDivElement>(null);
  const lastChatRef = useRef(0);
  lastChatRef.current = chat.length ? chat[chat.length - 1].id : 0;

  const seat = m.you;
  const meIdx = seat === 2 ? 1 : 0;
  const opIdx = seat === 2 ? 0 : 1;
  const opponent = seat === 2 ? m.p1 : m.p2;
  const self = seat === 2 ? m.p2 : m.p1;
  const iMoved = seat !== 0 && m.pending[seat - 1];
  const theyMoved = seat !== 0 && m.pending[seat === 1 ? 1 : 0];
  const waiting = m.status === "open";
  const done = m.status === "done";
  const myUsed = useMemo(() => new Set(seat === 2 ? m.used[1] : m.used[0]), [m.used, seat]);

  const absorb = useCallback((s: RpsMatch) => {
    if (s.rounds.length > seenRounds.current) {           // a fresh round resolved — play the reveal
      setReveal(s.rounds[s.rounds.length - 1]);
      seenRounds.current = s.rounds.length;
      setSealedTool(null);
    }
    if (s.clock) clock.current = { base: s.clock, at: Date.now(), run: s.clock_run ?? [false, false], show: (s.clock_s ?? 0) > 0 };
    setM({ ...s, chat: undefined });
    if (s.chat && s.chat.length) setChat((c) => [...c, ...(s.chat as NonNullable<typeof s.chat>).filter((x) => !c.some((y) => y.id === x.id))]);
  }, []);

  // stamp the received-at time on mount (Date.now() belongs in an effect, not render); polls restamp it.
  useEffect(() => { clock.current.at = Date.now(); }, []);
  // display value of a bank (index 0 = p1, 1 = p2): the running side counts down from what the server sent.
  const dispClock = (i: 0 | 1) => {
    const c = clock.current;
    const elapsed = c.at && c.run[i] && m.status === "live" ? (Date.now() - c.at) / 1000 : 0;
    return Math.max(0, c.base[i] - elapsed);
  };

  const refresh = useCallback(() => {
    rpsState(m.id, lastChatRef.current).then(absorb).catch(() => undefined);
  }, [m.id, absorb]);

  useEffect(() => {
    if (done) return;
    const h = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    return () => clearInterval(h);
  }, [done, refresh]);
  useEffect(() => {
    if (done) return;
    const h = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(h);
  }, [done]);
  // when a running bank reaches zero locally, poll at once so the server flags the match on time
  useEffect(() => {
    if (done || waiting) return;
    if ((clock.current.run[0] && dispClock(0) <= 0) || (clock.current.run[1] && dispClock(1) <= 0)) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, done, waiting]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "nearest" }); }, [chat.length]);

  const throwTool = (tool: string) => {
    if (busy || iMoved || done || waiting || seat === 0) return;
    setBusy(true); setErr(""); setSealedTool(tool);
    rpsMove(m.id, tool).then(absorb).catch((e) => { setSealedTool(null); setErr(e?.message || "That throw didn't land — try again"); }).finally(() => setBusy(false));
  };
  const send = () => {
    const body = msg.trim();
    if (!body) return;
    setMsg("");
    rpsChat(m.id, body).then(refresh).catch(() => setErr("Message didn't send"));
  };
  const claimIn = m.idle_claim_s - (now - m.last_move);
  const canClaim = !done && !waiting && iMoved && !theyMoved && claimIn <= 0;
  const roundNo = Math.min(m.rounds.length + 1, m.rounds_total);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <HandDefs />
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onExit}>← All games</Button>
          <Pill>◍ {gameTitle(m.game)}</Pill>
          <Pill>{m.rated ? "Rated" : "Practice"}</Pill>
          <Pill>Round {roundNo}/{m.rounds_total}</Pill>
          {m.mode !== "open" && <Pill>{m.mode === "bot-sharp" ? "ArtaBot · sharp" : "ArtaBot · chill"}</Pill>}
        </div>

        <PlayerBar p={opponent} score={m.score[opIdx]} you={false} pending={theyMoved}
          clock={dispClock(opIdx as 0 | 1)} running={clock.current.run[opIdx]} showClock={clock.current.show} />

        <Card className="relative my-4 p-4 sm:p-5">
          {waiting ? (
            <EmptyState icon="⏳" title="Waiting for an opponent" body="Your challenge is in the lobby. The first player to accept it starts the match — keep this page open." />
          ) : (
            <>
              <WheelDial arena={arenaOf(m.game)} interactive used={myUsed} sealed={sealedTool}
                disabled={busy || iMoved || done || seat === 0} onThrow={throwTool}
                center={<RoundHub label={gameTitle(m.game)} roundNo={roundNo} total={m.rounds_total} />} />
              <p className="mt-3 text-center text-[13px] text-ink-3">
                {done
                  ? (m.winner === 0 ? "Drawn — dead even." : (seat !== 0 && m.winner === seat) ? "You took the match." : seat !== 0 ? "The match went against you." : "Match over.")
                  : iMoved && !theyMoved ? "Your throw is sealed — waiting for the reveal…"
                  : theyMoved && !iMoved ? "They have sealed a throw. Answer it."
                  : "Pick any tool you haven't spent — throws reveal together."}
              </p>
              {canClaim && (
                <p className="mt-2 text-center">
                  <Button size="sm" variant="outline" onClick={() => rpsClaim(m.id).then(absorb).catch(() => undefined)}>Opponent idle — claim the match</Button>
                </p>
              )}
              {!done && !waiting && iMoved && !theyMoved && claimIn > 0 && claimIn < 120 && (
                <p className="mt-2 text-center text-[12px] text-ink-3">You can claim in {claimIn}s if they stay away.</p>
              )}
            </>
          )}
          {reveal && <RevealStage round={reveal} mineIsA={seat !== 2} onDone={() => setReveal(null)} />}
          {err && <StatusNote error>{err}</StatusNote>}
        </Card>

        <PlayerBar p={self} score={m.score[meIdx]} you pending={iMoved}
          clock={dispClock(meIdx as 0 | 1)} running={clock.current.run[meIdx]} showClock={clock.current.show} />

        {/* rounds strip: gesture pairs + my points */}
        {m.rounds.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Rounds so far">
            {m.rounds.map((r) => {
              const mine = seat === 2 ? r.b : r.a; const theirs = seat === 2 ? r.a : r.b;
              const my = seat === 2 ? r.pb : r.pa;
              return (
                <span key={r.r} title={`Round ${r.r}: ${TOOL_NAME[r.a as ToolKey]} vs ${TOOL_NAME[r.b as ToolKey]} (${r.pa > 0 ? "+" : ""}${r.pa} / ${r.pb > 0 ? "+" : ""}${r.pb})`}
                  className={cx("inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] font-bold ring-1",
                    my > 0 ? "bg-yang/15 text-yang ring-yang/30" : my < 0 ? "bg-yin/10 text-yin-light ring-yin/25" : "bg-veil/[0.06] text-ink-3 ring-line")}>
                  <HandGlyph tool={mine as ToolKey} width={17} />·<HandGlyph tool={theirs as ToolKey} width={17} blue mirror />
                  <span className="tabular-nums">{my > 0 ? `+${my}` : sc(my)}</span>
                </span>
              );
            })}
          </div>
        )}

        {done && (
          <Card className="mt-4 p-5 text-center">
            <p className="text-[17px] font-extrabold">
              {m.winner === 0 ? "Draw" : seat !== 0 && m.winner === seat ? "Victory" : seat !== 0 ? "Defeat" : `Player ${m.winner} wins`}
              <span className="ml-2 text-ink-3 tabular-nums">{scoreLine(m.score[0], m.score[1])}</span>
            </p>
            {m.rated && seat !== 0 && m.delta[meIdx] !== 0 && (
              <p className={cx("mt-1 text-[14px] font-bold", m.delta[meIdx] > 0 ? "text-yang" : "text-yin-light")}>
                {m.delta[meIdx] > 0 ? "+" : ""}{m.delta[meIdx]} Elo
              </p>
            )}
            <div className="mt-3 flex justify-center gap-2">
              <Button onClick={() => onRematch(m.mode, m.game)}>Rematch</Button>
              <Button variant="outline" onClick={onExit}>Back to the hall</Button>
            </div>
          </Card>
        )}
      </div>

      {/* chat rail */}
      <div className="flex min-h-[300px] flex-col rounded-card border border-line bg-veil/[0.03]">
        <p className="border-b border-line px-3.5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">Match chat</p>
        <div className="flex-1 space-y-2 overflow-y-auto px-3.5 py-3" style={{ maxHeight: 420 }}>
          {chat.length === 0 && <p className="text-[13px] text-ink-3">Say hello — good games start friendly.</p>}
          {chat.map((c) => (
            <p key={c.id} className="text-[13.5px] leading-snug"><b className={cx(c.uid === (self?.uid ?? -1) ? "text-yang" : "text-yin-light")}>{c.name}</b> <span className="text-ink-2">{c.body}</span></p>
          ))}
          <div ref={chatEnd} />
        </div>
        {seat !== 0 && (
          <div className="flex gap-2 border-t border-line p-2.5">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              maxLength={500} placeholder="Message…" aria-label="Chat message"
              className="h-9 min-w-0 flex-1 rounded-card border border-line bg-transparent px-3 text-[13.5px] outline-none focus:border-yin" />
            <Button size="sm" onClick={send} disabled={!msg.trim()}>Send</Button>
          </div>
        )}
        {!done && seat !== 0 && !waiting && (
          <div className="border-t border-line p-2.5 text-center">
            <Button size="sm" variant="ghost" onClick={() => rpsResign(m.id).then(() => refresh()).catch(() => undefined)}>Resign</Button>
          </div>
        )}
        {waiting && seat !== 0 && (
          <div className="border-t border-line p-2.5 text-center">
            <Button size="sm" variant="ghost" onClick={() => rpsResign(m.id).then(onExit).catch(() => undefined)}>Withdraw challenge</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the hub ────────────────────────────────────────────────────────────────── */
/** FOCUS MODE — the reader's ReadMode conventions applied to play: a full-viewport dialog over the
 *  app chrome (real fullscreen where granted, fixed-inset overlay as the always-correct fallback),
 *  body scroll locked, Esc — or an unintentional fullscreen exit — leaves, focus moves to the exit
 *  button on open and back to the toggle on close. State lives in GamesPage so entering a match
 *  mid-focus stays focused (the overlay remounts across the hub↔match switch; a re-request of real
 *  fullscreen without a fresh gesture may be denied, and the overlay fallback still covers all). */
function FocusFrame({ embedded, focus, setFocus, children }: {
  embedded?: boolean; focus: boolean; setFocus: (v: boolean) => void; children: ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const intentional = useRef(false);

  useEffect(() => {
    if (!focus) return;
    const scrollY = window.scrollY;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    overlayRef.current?.requestFullscreen?.().catch(() => { /* denied → the fixed-inset overlay already covers */ });
    closeRef.current?.focus();
    let entered = false;
    const onFs = () => {
      if (document.fullscreenElement) { entered = true; return; }
      if (intentional.current) { intentional.current = false; return; }
      if (entered) setFocus(false); // browser-level Esc/F11 exit = leave focus mode (one Esc feels natural)
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setFocus(false); } };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) { intentional.current = true; document.exitFullscreen?.().catch(() => {}); }
      document.body.style.overflow = prev;
      window.scrollTo(0, scrollY);
    };
  }, [focus, setFocus]);

  // Restore focus to the toggle AFTER leaving focus mode (the toggle only exists in the normal frame,
  // so this runs once the exit re-render has put it back — cleaner than touching the ref in cleanup).
  const wasFocused = useRef(false);
  useEffect(() => {
    if (focus) { wasFocused.current = true; return; }
    if (wasFocused.current) { wasFocused.current = false; toggleRef.current?.focus(); }
  }, [focus]);

  if (!focus) {
    return (
      <div className={cx("relative", !embedded && "mx-auto w-full max-w-5xl px-4 py-6 sm:px-6")}>
        <button ref={toggleRef} type="button" onClick={() => setFocus(true)}
          title="Focus mode — just the game, full screen (Esc leaves)"
          className="absolute right-4 top-6 z-10 flex items-center gap-1.5 rounded-pill border border-line bg-space-2/80 px-3 py-1.5 text-[12px] font-semibold text-ink-3 backdrop-blur transition-colors hover:border-yang/60 hover:text-ink">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          Focus
        </button>
        {children}
      </div>
    );
  }
  return (
    <div ref={overlayRef} role="dialog" aria-modal="true" aria-label="ArtaRPS — focus mode"
      className="fixed inset-0 z-[120] overflow-y-auto overscroll-contain bg-space">
      <button ref={closeRef} type="button" onClick={() => setFocus(false)}
        className="fixed right-4 top-4 z-10 flex items-center gap-1.5 rounded-pill border border-line bg-space-2/80 px-3 py-1.5 text-[12px] font-semibold text-ink-3 backdrop-blur transition-colors hover:border-yang/60 hover:text-ink">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
        Exit focus · Esc
      </button>
      <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">{children}</div>
    </div>
  );
}

/* ── the catalogue: three games, Library-card style ─────────────────────────── */
/** A game card: a mini structural wheel of its tools + name, level and blurb → its own page. */
function GameCard({ g }: { g: GameDef }) {
  const tools = GAME_TOOLS[g.id];
  return (
    <Card as={Link} to={localePath(`/game/${g.slug}`)}
      className="group flex h-full flex-col gap-3 p-4 no-underline transition-colors hover:border-yang/50 sm:p-5">
      <div className="relative mx-auto w-full max-w-[220px]">
        <WheelDial arena={tools} center={
          <p className="text-[22px] font-black leading-none tabular-nums text-ink">{tools.length}<span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3">tools</span></p>
        } />
      </div>
      <div className="mt-auto">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[18px] font-black tracking-tight text-ink">{g.title}</h3>
          <Pill>{g.level}</Pill>
        </div>
        <p className="mt-0.5 text-[12.5px] font-semibold text-yang">{g.tagline} · {g.rounds} rounds</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{g.blurb}</p>
        <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-bold text-yin-light group-hover:underline">Play {g.title} →</span>
      </div>
    </Card>
  );
}

function GamesCatalog({ embedded }: { embedded?: boolean }) {
  return (
    <div className={cx(!embedded && "mx-auto w-full max-w-5xl px-4 py-6 sm:px-6")}>
      <HandDefs />
      {!embedded && (
        <PageHero eyebrow="ArtaRPS" title="Games"
          lede="Rock–paper–scissors, grown up — a ladder of three hand-sign games on one gold-and-blue wheel. Pick one and play a rated 10-minute match against the world, or a practice bot. Every duel is decided by the Twelve Laws." />
      )}
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {GAMES.map((g) => <GameCard key={g.id} g={g} />)}
      </div>
      <p className="mt-5 text-center text-[12.5px] text-ink-3">
        Each game is a 10-minute chess-style match — your clock ticks only while it's your throw. The printed 145-card edition is in the{" "}
        <a className="font-semibold text-yin-light hover:underline" href={localePath("/shop/")}>Shop</a>.
      </p>
    </div>
  );
}

/* ── one game's page: hero, board, play controls, lobby, leaderboard, rules ──── */
function GameHub({ game, embedded }: { game: GameDef; embedded?: boolean }) {
  const [board, setBoard] = useState<RpsBoard | null>(null);
  const [focus, setFocus] = useState(false);
  const [match, setMatch] = useState<RpsMatch | null>(null);
  const [tab, setTab] = useState("play");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const logged = isLoggedIn();
  const tools = GAME_TOOLS[game.id];

  const load = useCallback(() => { rpsBoard().then(setBoard).catch(() => setErr("Couldn't load the games hall — refresh")); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (match) return;
    const h = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => clearInterval(h);
  }, [match, load]);

  const start = (mode: RpsMode, g: string = game.id) => {
    if (busy) return;
    setBusy(true); setErr("");
    rpsCreate(mode, g as GameId).then((m) => { setMatch({ ...m, chat: [] }); }).catch((e) => setErr(e?.message || "Couldn't start a match")).finally(() => setBusy(false));
  };
  const join = (id: number) => {
    if (busy) return;
    setBusy(true); setErr("");
    rpsJoin(id).then((m) => setMatch({ ...m, chat: [] })).catch((e) => { setErr(e?.message || "That challenge was already taken"); load(); }).finally(() => setBusy(false));
  };

  if (match) {
    return (
      <FocusFrame embedded={embedded} focus={focus} setFocus={setFocus}>
        <MatchBoard match={match} onExit={() => { setMatch(null); load(); }} onRematch={(mode, g) => { setMatch(null); start(mode, g); }} />
      </FocusFrame>
    );
  }

  const live = board?.mine.filter((m) => m.status !== "done") ?? [];
  const recent = board?.mine.filter((m) => m.status === "done") ?? [];
  const lobby = (board?.lobby ?? []).filter((l) => (l.game || l.ring) === game.id);

  return (
    <FocusFrame embedded={embedded} focus={focus} setFocus={setFocus}>
      <HandDefs />
      {!embedded && (
        <p className="mb-3">
          <Link to={localePath("/games/")} className="text-[13px] font-semibold text-ink-3 hover:text-ink">← All games</Link>
        </p>
      )}
      <Masthead compact={embedded} game={game} />

      <Tabs className="mt-5" active={tab} onChange={setTab} label={`${game.title} sections`}
        tabs={[{ key: "play", label: "Play" }, { key: "leaderboard", label: "Leaderboard" }, { key: "rules", label: "Rules" }]} />

      {err && <StatusNote error>{err}</StatusNote>}

      {tab === "play" && (
        <div className="mt-5 space-y-6">
          {!logged && <SignInGate title="Sign in to play" body="Matches, ratings and chat need an account — watching the leaderboard doesn't." />}

          {logged && live.length > 0 && (
            <section>
              <h2 className="mb-2 text-[15px] font-bold">Your live matches</h2>
              <div className="flex flex-wrap gap-2">
                {live.map((m) => (
                  <Button key={m.id} variant="outline" onClick={() => setMatch({ ...m, chat: [] })}>
                    ◍ {gameTitle(m.game)} · {m.status === "open" ? "Waiting…" : `vs ${(m.you === 2 ? m.p1 : m.p2)?.name ?? "ArtaBot"} · ${scoreLine(m.score[0], m.score[1])}`}
                  </Button>
                ))}
              </div>
            </section>
          )}

          {/* the board + play controls */}
          <section className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_268px]">
            <Card className="p-4 sm:p-5">
              <WheelDial arena={tools} center={
                <>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-3">{game.title}</p>
                  <p className="mt-1 text-[24px] font-black leading-none tabular-nums text-ink">{tools.length}<span className="text-[13px] font-bold text-ink-3"> tools</span></p>
                  <p className="mt-1 text-[11px] leading-snug text-ink-3">each takes what it can · duels decide it</p>
                </>
              } />
              <p className="mt-1 text-center text-[11.5px] text-ink-3">Hover a hand to see it throw · lines show what each takes</p>
            </Card>
            <div className="flex flex-col gap-2.5">
              <Button size="lg" disabled={!logged || busy} onClick={() => start("open")}>⚡ Play online — rated</Button>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={!logged || busy} onClick={() => start("bot-sharp")}>Bot · sharp</Button>
                <Button variant="outline" disabled={!logged || busy} onClick={() => start("bot-chill")}>Bot · chill</Button>
              </div>
              <div className="mt-1 rounded-card border border-line bg-veil/[0.03] p-3">
                <p className="text-[12px] font-bold text-ink">{game.rounds} rounds · every tool once · ⏱ 10-min clock</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
                  An alliance pays <b className="text-yang">both</b>, a duel pays its <b className="text-yang">winner</b> and stings the loser, a clash costs <b className="text-yin-light">both</b>. Your clock ticks only while it's your throw — run out and you lose on time.
                </p>
              </div>
            </div>
          </section>

          {/* lobby (this game only) */}
          <section>
            <h2 className="mb-2 text-[15px] font-bold">Open {game.title} challenges</h2>
            {!board ? <StatusNote>Loading…</StatusNote> : lobby.length === 0 ? (
              <p className="text-[13.5px] text-ink-3">Nobody is waiting on {game.title} right now — start a rated match above and you become the challenge.</p>
            ) : (
              <div className="space-y-2">
                {lobby.map((l) => (
                  <div key={l.id} className="flex items-center gap-3 rounded-card border border-line px-3.5 py-2.5">
                    <Avatar name={l.by.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold">{l.by.name} <RatingPill p={l.by} /></p>
                      <p className="text-[12px] text-ink-3">◍ {gameTitle(l.game || l.ring)} · rated · 10-min clock</p>
                    </div>
                    <Button size="sm" disabled={!logged || busy || l.by.uid === board.me?.uid} onClick={() => join(l.id)}>Accept</Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {logged && recent.length > 0 && (
            <section>
              <h2 className="mb-2 text-[15px] font-bold">Recent results</h2>
              <div className="flex flex-wrap gap-2">
                {recent.map((m) => {
                  const meIdx = m.you === 2 ? 1 : 0;
                  const res = m.winner === 0 ? "½–½" : m.winner === m.you ? "won" : "lost";
                  return (
                    <Button key={m.id} variant="subtle" size="sm" onClick={() => setMatch({ ...m, chat: [] })}>
                      ◍ {gameTitle(m.game)} · {res} {scoreLine(m.score[0], m.score[1])}{m.rated && m.delta[meIdx] !== 0 ? ` · ${m.delta[meIdx] > 0 ? "+" + m.delta[meIdx] : sc(m.delta[meIdx])}` : ""}
                    </Button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "leaderboard" && (
        <div className="mt-5">
          {!board ? <StatusNote>Loading…</StatusNote> : board.leaderboard.length === 0 ? (
            <EmptyState icon="♟" title="No rated games yet" body="Win rated online matches to put your name here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] uppercase tracking-[0.12em] text-ink-3">
                    <th className="py-2 pr-3 font-semibold">#</th><th className="py-2 pr-3 font-semibold">Player</th>
                    <th className="py-2 pr-3 text-right font-semibold">Rating</th><th className="py-2 pr-3 text-right font-semibold">W</th>
                    <th className="py-2 pr-3 text-right font-semibold">L</th><th className="py-2 text-right font-semibold">D</th>
                  </tr>
                </thead>
                <tbody>
                  {board.leaderboard.map((r) => (
                    <tr key={r.uid} className={cx("border-b border-line/60", board.me?.uid === r.uid && "bg-yang/[0.06]")}>
                      <th scope="row" className="py-2.5 pr-3 text-left font-bold tabular-nums">{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}</th>
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2">
                          <Avatar name={r.name} />
                          {r.slug ? <a className="truncate font-semibold hover:underline" href={`/u/${r.slug}`}>{r.name}</a> : <span className="truncate font-semibold">{r.name}</span>}
                          {board.me?.uid === r.uid && <span className="rounded-pill bg-yin/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-yin-light">you</span>}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-bold tabular-nums">{r.rating}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{r.wins}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{r.losses}</td>
                      <td className="py-2.5 text-right tabular-nums">{r.draws}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-ink-3">One rating across all three games — a win is a win, whichever board.</p>
            </div>
          )}
        </div>
      )}

      {tab === "rules" && (
        <div className="mt-5 max-w-2xl space-y-4 text-[14.5px] leading-relaxed text-ink-2">
          <p><b className="text-ink">{game.title} — {tools.length} tools, {game.rounds} rounds.</b> Each round both players secretly throw one of the tools they haven't spent — a hand sign — and the throws reveal together. Every tool is thrown <b className="text-ink">exactly once</b>.</p>
          <p>The wheel decides each reveal. Between the two tools: <b className="text-yang">an alliance lifts BOTH</b> (+2 or +3 each); <b className="text-ink">a duel</b> pays its winner +2 and stings the loser −2, and the Twelve Laws below say who wins; anything else <b className="text-yin-light">clashes — both fall</b> (−2 each). Highest total takes the match; online matches move Elo (K = 32).</p>
          <p><b className="text-ink">The clock.</b> Each player gets <b>10 minutes</b>, chess-style — but it ticks only while it's <i>your</i> throw to seal. A few seconds are added back every round (so you never flag on the reveal). Run your bank to zero before you throw and you lose on time.</p>
          <Card className="p-4">
            <p className="font-bold">The Twelve Laws — who beats whom</p>
            <div className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
              {LAWS.map((law, i) => (
                <p key={law} className={cx("flex items-center gap-2 text-[13.5px]", tools.includes(TOOL_KEYS[i]) ? "text-ink-2" : "text-ink-3")}>
                  <HandGlyph tool={TOOL_KEYS[i]} width={26} className="shrink-0" />
                  <span>{law}</span>
                </p>
              ))}
            </div>
            {tools.length < 12 && <p className="mt-2 text-[12px] text-ink-3">Faded laws belong to tools outside {game.title} — you meet them on the bigger boards.</p>}
          </Card>
          <p>ArtaBot <i>chill</i> throws its remaining tools at random — unbeatable in expectation. ArtaBot <i>sharp</i> hunts patterns in what you have left and punishes them.</p>
          <p>The printed 145-card edition — twelve decks, the Twelve Laws on every card — is in the <a className="font-semibold text-yin-light hover:underline" href={localePath("/shop/")}>Shop</a>.</p>
        </div>
      )}
    </FocusFrame>
  );
}

/** The Games surface: a catalogue of three games (bare /games or the Library tab), or one game's
 *  page (/game/<slug>). `game` is the URL slug when we're on a single game. */
export default function GamesPage({ embedded, game: slug }: { embedded?: boolean; game?: string }) {
  const id = gameFromSlug(slug);
  if (!id) return <GamesCatalog embedded={embedded} />;
  return <GameHub game={GAME_BY_ID[id]} embedded={embedded} />;
}
