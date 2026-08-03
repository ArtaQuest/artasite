/**
 * The Twelve Seasons — shared UI (operator directives 2026-07-10).
 *
 * <SeasonSigil/>   — the season's card RANK ("Q", "1" … "10", "J"), toned by its stability:
 *                    blue (the initiators), gold (the steady), the gold→blue blend (the adaptive).
 *                    No suits anywhere (operator 2026-07-11).
 * <SeasonBadge/>   — small round card-emblem badge for the corner of an avatar (FlagBadge's
 *                    twin), so a member's picture always carries their season card even when
 *                    they've uploaded their own photo.
 * <SeasonNow/>     — the recommendation module: the member's ONE subscribed season is the WHAT
 *                    (the topic family they follow); the running season is the HOW (its craft).
 *                    Replaces the retired "what to study now" compass. The cycle is a
 *                    sinusoid — never draw it as a wheel.
 */
import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { type Season, currentSeason, seasonAvatar, seasonByN, seasonForBirthday, seasonForPhase, seasonSpan, seasonTitle } from "../lib/seasons";
import { Disciplines, SeasonsApi, type Discipline } from "../lib/api";
import { currentUser, isLoggedIn, localePath } from "../lib/wp";
import { cx } from "./ui";

/** The gold→blue blend for dual-toned ranks — its midpoint is pure neutral (the pair are exact
 *  complements), so no third hue ever appears. */
export const DUAL_TEXT: React.CSSProperties = {
  backgroundImage: "linear-gradient(105deg, var(--color-yang-ink), var(--color-yin-ink))",
  WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
};

/** The season's RANK ("Q", "1" … "10", "J"), stability-toned. Ranks only — never a suit. */
export function SeasonSigil({ season, className }: { season: Season; className?: string }) {
  if (season.tone === "dual") return <span className={cx("whitespace-nowrap font-semibold", className)} style={DUAL_TEXT}>{season.rank}</span>;
  return <span className={cx("whitespace-nowrap font-semibold", season.tone === "yang" ? "text-yang-ink" : "text-yin-light", className)}>{season.rank}</span>;
}

/** Corner badge: the member's season card emblem on their avatar (mirror of FlagBadge). */
export function SeasonBadge({ n, className }: { n?: number | null; className?: string }) {
  const s = seasonByN(n);
  if (!s) return null;
  const label = `Season ${s.rank} — ${seasonTitle(s)}`;
  return (
    <span role="img" aria-label={label} title={label}
      className={cx("absolute -left-[10%] -top-[10%] block aspect-square w-[40%] min-w-3.5 overflow-hidden rounded-full border border-line bg-space-2", className)}>
      <img src={seasonAvatar(s.n)} alt="" className="h-full w-full" loading="lazy" />
    </span>
  );
}

/** The viewer's season: explicit subscription (server-injected / freshly saved), else birth season. */
export function mySeason(): Season | null {
  const u = currentUser();
  if (!u) return null;
  return seasonByN(u.season) || seasonForBirthday(u.birthday);
}

/** One season's topics (the atlas disciplines whose fitted peak falls in it), best first. */
export function topicsOfSeason(discs: Discipline[], s: Season): Discipline[] {
  return discs
    .filter((d) => seasonForPhase(d.sign)?.n === s.n)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.label || "").localeCompare(b.label || ""));
}

/** The season hero card used on Home — what the world makes now, and your topic family. */
export default function SeasonNow() {
  const now = currentSeason();
  const [mine, setMine] = useState<Season | null>(() => mySeason());
  const [discs, setDiscs] = useState<Discipline[]>([]);
  useEffect(() => {
    Disciplines.list().then((d) => setDiscs(d.disciplines || [])).catch(() => {});
    if (isLoggedIn()) SeasonsApi.wheel().then((w) => { if (w.mine) setMine(seasonByN(w.mine)); }).catch(() => {});
  }, []);
  const myTopics = useMemo(() => (mine ? topicsOfSeason(discs, mine).slice(0, 8) : []), [discs, mine]);

  return (
    <section aria-label="The season now" className="rounded-card border border-line bg-space-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <img src={seasonAvatar(now.n)} alt="" className="h-12 w-12 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold tracking-tight">
            <SeasonSigil season={now} className="me-1.5" />{seasonTitle(now)} <span className="font-normal text-ink-3">· {seasonSpan(now)}</span>
          </h2>
          <p className="text-[13px] leading-snug text-ink-3">{now.legend}</p>

        </div>
        <a href={localePath(now.createHref)} className="shrink-0 rounded-pill bg-yang px-3.5 py-1.5 text-[13px] font-semibold text-on-accent hover:opacity-90">
          {now.craftLabel} season — create one →
        </a>
      </div>
      {mine && (
        <div className="mt-3 border-t border-line/60 pt-3">
          <p className="mb-1.5 text-[12px] text-ink-3">
            Your season is <b className="text-ink-2">{seasonTitle(mine)}</b> (<SeasonSigil season={mine} />){mine.n === now.n ? " — it is running right now." : ` — ${seasonSpan(mine)}.`} Its topics, in this season&rsquo;s craft:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {myTopics.map((d) => (
              <a key={d.key} href={localePath(`/topics/?field=${encodeURIComponent(d.key)}`)}
                className="rounded-full border border-line bg-space-3/40 px-2.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-yin-light hover:text-yin-light">
                {d.label}
              </a>
            ))}
            <a href={localePath("/topics/")} className="rounded-full px-2.5 py-1 text-[12.5px] font-semibold text-yin-light hover:underline">the whole cycle →</a>
          </div>
        </div>
      )}
      {!mine && (
        <p className="mt-3 border-t border-line/60 pt-3 text-[12.5px] text-ink-3">
          Every member follows ONE of the twelve seasons — by default the one they were born in.{" "}
          <a href={localePath("/topics/")} className="font-semibold text-yin-light hover:underline">Pick yours on the cycle →</a>
        </p>
      )}
    </section>
  );
}
