import { useId } from "react";
import type { PartCert } from "../lib/api";
import { LogoMark, cx } from "./ui";

const BASE = import.meta.env.BASE_URL || "/";

/* ═══════════════════════ THE CERTIFICATE OF PARTICIPATION ═══════════════════════
 *
 * EVERY entrant of a challenge holds one — sponsored or not. That is the whole point: the document
 * exists because they made something and entered it, and a donor's plate is an ADDITION to a
 * certificate that already exists, never its precondition. So it can never read as a receipt for
 * charity, and an unsponsored certificate has no empty box where a benefactor should have been.
 *
 * It is a DIFFERENT OBJECT from the course diploma (pages/Certificate.tsx), not a reskin of it:
 *
 *            course diploma                    certificate of participation
 *   shape    portrait, centred, symmetrical    landscape, left-ranged, asymmetrical
 *   frame    gold outside, blue inside         blue outside, gold inside (inverted)
 *   mark     a struck podium medallion         an engraved lunar seal — 28 ticks, one per day of
 *                                              the synodic month the challenge ran to
 *   ground   concentric guilloché              a horizon rule under the record
 *   footer   one signature plate               two plates: the founder's, and the donor's
 *
 * PRINT. The app is a dark theme; index.css:740-747 isolates `.aq-cert`, forces text to near-black
 * and strips dark fills, while SVG `fill`/`stroke` ATTRIBUTES survive (print-color-adjust: exact).
 * So every colour here is an SVG attribute or an inline rgba border — never a CSS `color` — which is
 * why the seal, the frame and the signature keep their colour on paper. The frame values are
 * deliberately FIXED literals rather than brand tokens: a certificate is a printed artefact, and it
 * must render identically for a reader whose ArtaContrast setting we will never know.
 *
 * i18n. The mesh publishes rendered strings, so every proper noun, code and member-authored title
 * carries data-ay-skip="1" — a person's name and a work's title are not ours to translate.
 */

const GOLD = "#E8B923";
const GOLD_DEEP = "#C49B1A";
const BLUE = "#2352E8";   // the brand-blue SENTINEL — the global remap maps it to the live token

function fmtDate(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ───────────────────────── the lunar seal ─────────────────────────
 * A challenge runs to a FULL MOON, so the seal is a moon: 28 ticks around the rim, one for each day
 * of the synodic month, with the twelve-o'clock tick struck long and gold — the moon it closed at.
 * The disc is engraved rather than illustrated: three maria as flat deeper-gold shapes, no gradient,
 * so it prints as cleanly at 100mm as it renders at 168px. */
function LunarSeal({ className }: { className?: string }) {
  const id = useId();
  const ticks = Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2 - Math.PI / 2;      // 0 = twelve o'clock
    const full = i === 0;
    const r0 = full ? 60 : 66, r1 = 72;
    return {
      x1: 80 + Math.cos(a) * r0, y1: 80 + Math.sin(a) * r0,
      x2: 80 + Math.cos(a) * r1, y2: 80 + Math.sin(a) * r1,
      w: full ? 3 : i % 7 === 0 ? 1.8 : 1,
      o: full ? 1 : i % 7 === 0 ? 0.75 : 0.4,
    };
  });
  return (
    <svg viewBox="0 0 160 160" className={cx("h-auto", className)} role="img" aria-label="ArtaQuest lunar seal" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id={`${id}-disc`}><circle cx="80" cy="80" r="47" /></clipPath>
      </defs>
      {/* rim: a blue outer ring, the 28 day-ticks, then a fine gold inner ring */}
      <circle cx="80" cy="80" r="76" fill="none" stroke={BLUE} strokeWidth="1.6" strokeOpacity="0.7" />
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={GOLD_DEEP} strokeWidth={t.w} strokeOpacity={t.o} strokeLinecap="round" />
      ))}
      <circle cx="80" cy="80" r="55" fill="none" stroke={GOLD_DEEP} strokeWidth="0.9" strokeOpacity="0.55" />
      {/* the full moon itself */}
      <circle cx="80" cy="80" r="47" fill={GOLD} fillOpacity="0.14" stroke={GOLD} strokeWidth="1.8" />
      <g clipPath={`url(#${id}-disc)`} fill={GOLD_DEEP} fillOpacity="0.3">
        <ellipse cx="64" cy="66" rx="16" ry="13" />
        <ellipse cx="95" cy="88" rx="12" ry="10" />
        <ellipse cx="70" cy="99" rx="8" ry="6.5" />
      </g>
      {/* the ring-through-A brand mark, engraved small at the moon's centre */}
      <circle cx="80" cy="80" r="19" fill="none" stroke={BLUE} strokeWidth="2.2" />
      <path d="M80 68 L88 92 M80 68 L72 92 M75.4 84 H84.6" fill="none" stroke={GOLD} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* A single corner tick — an engraver's register mark, not the diploma's flourish. */
function CornerTick({ className, rotate }: { className: string; rotate: number }) {
  return (
    <svg className={cx("pointer-events-none absolute h-7 w-7", className)} viewBox="0 0 28 28" fill="none" aria-hidden style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M2 9 V2 H9" stroke={GOLD_DEEP} strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  );
}

/** The founder's signature — his real hand, from public/signature.png. Black ink on transparent, so
 *  `.aq-sig-img` (index.css) inverts it on the dark cosmos, leaves it as scanned on the LIGHT theme
 *  — where inverting made it white-on-white and the signature disappeared — and always prints it as
 *  ink. Falls back to a cursive stand-in only if the asset is ever missing, so the document is never
 *  unfinished. */
function FounderSignature() {
  return (
    <img
      src={`${BASE}signature.png`}
      alt="Arash Ashrafnejad signature"
      width={1400} height={516}
      className="aq-sig-img block h-auto w-[150px] max-w-full object-contain"
      data-ay-skip="1"
      onError={(e) => {
        const el = e.currentTarget;
        el.style.display = "none";
        el.insertAdjacentHTML("afterend", '<span class="aq-sig block text-[21px] leading-none text-ink" data-ay-skip="1">Ashrafnejad</span>');
      }}
    />
  );
}

/* ───────────────────────── the document ─────────────────────────
 * Presentational and pure: the same component renders the member's own certificate, the public
 * verification view, and the live sample on the donate page. `sample` softens nothing — it only
 * marks the document so a reader can never mistake a preview for an issued certificate. */
export function ParticipationDoc({ cert, sample = false }: { cert: PartCert; sample?: boolean }) {
  const placed = cert.settled && cert.place > 0;
  return (
    <article className={cx("aq-cert relative mx-auto w-full max-w-5xl overflow-hidden rounded-card bg-space-2 p-2.5", sample && "select-none")}>
      {/* inverted frame: fine BLUE outside, gold within — the diploma is the other way round.
          NOTE the literal. The #2352E8 sentinel is remapped by ATTRIBUTE selectors only
          (index.css:348 — [fill=]/[stroke=]/[stop-color=]), so it is correct inside the SVGs above
          and WRONG here: a CSS border is never remapped, and #2352E8 is the retired blue that sums
          to 267 with gold instead of to white. The frame uses the real yin, #1746DC. */}
      <div className="relative rounded-[14px] border-2 p-1.5" style={{ borderColor: "rgba(23,70,220,0.5)" }}>
        <div className="relative overflow-hidden rounded-[10px] border bg-space-1 px-6 py-9 sm:px-12 sm:py-11" style={{ borderColor: "rgba(232,185,35,0.5)" }}>
          <div className="aq-glow pointer-events-none absolute -right-32 -top-32 h-80 w-80 rounded-full bg-yang/[0.08] blur-3xl" aria-hidden />
          <CornerTick className="left-2 top-2" rotate={0} />
          <CornerTick className="right-2 top-2" rotate={90} />
          <CornerTick className="bottom-2 right-2" rotate={180} />
          <CornerTick className="bottom-2 left-2" rotate={270} />

          {sample && (
            <p className="aq-no-print absolute right-4 top-4 rounded-pill border border-line px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-3">
              Sample
            </p>
          )}

          {/* ── the record (left) and the seal (right) ── */}
          <div className="relative grid grid-cols-1 gap-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-10">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 text-ink">
                <LogoMark className="h-7 w-7" />
                <span className="text-[16px] font-bold tracking-tight" data-ay-skip="1">ArtaQuest</span>
                <span className="text-[9px] font-semibold uppercase tracking-[0.28em] text-ink-2">Foundation</span>
              </div>

              <div className="mt-7 flex items-center gap-3">
                <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.34em] text-yang">Certificate of Participation</span>
                <span className="h-px flex-1 bg-yang/30" aria-hidden />
              </div>

              <p className="mt-6 text-[12.5px] italic leading-none text-ink-3">This records that</p>
              <h1 data-ay-skip="1" className="mt-3 font-display text-[clamp(1.7rem,4.2vw,2.6rem)] font-extrabold leading-[1.05] tracking-[-0.025em] text-ink">
                {cert.member}
              </h1>
              <div className="mt-3.5 h-px w-full max-w-sm bg-gradient-to-r from-yang/55 to-transparent" aria-hidden />

              <p className="mt-5 max-w-xl text-[13.5px] leading-relaxed text-ink-2">
                entered the challenge{" "}
                <span className="font-bold text-yang" data-ay-skip="1">{cert.challenge}</span>{" "}
                with the work{" "}
                <span className="font-semibold text-ink" data-ay-skip="1">{cert.work}</span>
              </p>
              <p className="mt-2 text-[11.5px] uppercase tracking-[0.14em] text-ink-3">
                <span data-ay-skip="1">{cert.kind}</span> · <span data-ay-skip="1">{cert.topic}</span> · closed at the full moon of{" "}
                <span data-ay-skip="1">{fmtDate(cert.moon_ts)}</span>
              </p>

              {/* Placement comes ONLY from the frozen settlement board, so nothing printed here can
                  change afterwards. Until the moon there is simply no placement line — an entry that
                  has not been judged is not a rank of zero. */}
              {placed ? (
                <p className="mt-5 inline-flex items-center gap-2 rounded-pill border border-yang/40 bg-yang/10 px-3.5 py-1.5 text-[12px] font-semibold text-yang" data-ay-skip="1">
                  {ordinal(cert.place)} of {cert.field} by hearts
                  {cert.prize > 0 ? <span className="font-extrabold">· ₳{cert.prize} won</span> : null}
                </p>
              ) : (
                <p className="mt-5 text-[12px] text-ink-3">
                  {cert.settled ? "Judged at the full moon" : "Open until the full moon — the placement is added when the challenge closes"}
                </p>
              )}
            </div>

            <div className="flex justify-center sm:block">
              <LunarSeal className="w-[132px] sm:w-[164px]" />
            </div>
          </div>

          {/* ── the horizon rule, then the plates ── */}
          <div className="mt-9 h-px w-full bg-line" aria-hidden />
          <div className={cx("mt-6 grid gap-x-10 gap-y-8", cert.sponsored ? "sm:grid-cols-[auto_1fr_auto]" : "sm:grid-cols-[auto_1fr]")}>
            {/* the Foundation's plate */}
            <div className="flex flex-col items-center sm:items-start">
              <FounderSignature />
              <div className="mt-1.5 w-full border-t border-line/70 pt-2 text-center sm:text-left">
                <p className="text-[17px] font-semibold leading-none tracking-tight text-ink" data-ay-skip="1">Arash Ashrafnejad</p>
                <p className="mt-1 whitespace-nowrap text-[9.5px] tracking-[0.01em] text-ink-2">Founder · ArtaQuest Foundation</p>
              </div>
            </div>

            {/* the DONOR's plate — present only when a donor actually paid this entry fee. When they
                did not, the grid collapses to two columns and there is no visible absence. */}
            {cert.sponsored && (
              <div className="flex flex-col justify-end sm:col-start-3 sm:items-end sm:text-right">
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.24em] text-yang">Entry fee given by</span>
                <p className="mt-1.5 text-[17px] font-semibold leading-tight tracking-tight text-ink" data-ay-skip={cert.donor ? "1" : undefined}>
                  {cert.donor || "A friend of ArtaQuest"}
                </p>
                {cert.slice && <p className="mt-1 max-w-[16rem] text-[10.5px] leading-snug text-ink-2">for {cert.slice}</p>}
              </div>
            )}

            {/* the record line, centred between the plates on wide screens */}
            <div className={cx("text-center", cert.sponsored ? "sm:col-start-2 sm:row-start-1 sm:self-end" : "sm:col-start-2 sm:self-end sm:text-right")}>
              <p className="font-mono text-[12px] leading-none tracking-[0.14em] text-ink-2" data-ay-skip="1">{cert.code || "—"}</p>
              <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-ink-2">Verification code</p>
              <p className="mt-3 text-[11px] leading-none text-ink-2" data-ay-skip="1">{fmtDate(cert.entered_ts)}</p>
              <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-ink-2">Date entered</p>
            </div>
          </div>

          <p className="mx-auto mt-7 max-w-xl text-center text-[9.5px] leading-relaxed tracking-[0.02em] text-ink-2">
            Issued by the ArtaQuest Foundation · anyone may confirm this certificate at{" "}
            <span data-ay-skip="1">artaquest.com/verify</span>
          </p>
        </div>
      </div>
    </article>
  );
}

