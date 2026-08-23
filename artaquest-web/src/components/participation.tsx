import type { PartCert } from "../lib/api";
import { cx } from "./ui";
import { uiLocale } from "../lib/wp";

const BASE = import.meta.env.BASE_URL || "/";

/* ═══════════════════════ THE CERTIFICATE OF PARTICIPATION ═══════════════════════
 *
 * EVERY entrant of a challenge holds one — sponsored or not. That is the whole point: the document
 * exists because they made something and entered it, and a donor's plate is an ADDITION to a
 * certificate that already exists, never its precondition. So it can never read as a receipt for
 * charity, and an unsponsored certificate has no empty box where a benefactor should have been.
 *
 * ── WHAT THIS DOCUMENT IS, AFTER 2026-08-15 ────────────────────────────────────────────────────
 * One rule, one mark, four facts, two names. Everything that was decoration is gone.
 *
 * It used to carry a double frame (blue outside, gold within), four engraver's register ticks, a
 * corner glow, a gradient hairline, and a 168px LUNAR SEAL — a moon with twenty-eight rim ticks,
 * one per day of the synodic month, with three maria engraved on its face. None of it said anything
 * about the person holding it. A certificate earns attention with the name on it, and every stroke
 * that is not that name is competing with it.
 *
 * The moon is gone entirely, and deliberately. A challenge does run to a full moon, and that is a
 * lovely fact about the PLATFORM — but on a document about one person's work it was trivia, stated
 * three times over: in the seal, in "closed at the full moon of …", and again in the placement line.
 * What a reader of this certificate needs is who, what, when, and how to check it.
 *
 * The mark that replaced the seal is the ring-through-A itself, drawn once at a restrained size. It
 * is the Foundation's own mark rather than a motif invented for this page, which is what makes the
 * document bespoke rather than decorated.
 *
 * PRINT. The app is a dark theme; the @media print block in index.css isolates `.aq-cert`, forces
 * text to near-black and strips dark fills, while SVG `fill`/`stroke` ATTRIBUTES survive
 * (print-color-adjust: exact). So every colour here is an SVG attribute or an inline rgba border —
 * never a CSS `color` — which is why the mark, the rule and the signature keep their colour on
 * paper. `aq-cert-plain` switches OFF the 3px outer frame that block draws: that frame belongs to
 * the course diploma, which has no border of its own, and this document brings its own hairline. The frame values are
 * deliberately FIXED literals rather than brand tokens: a certificate is a printed artefact, and it
 * must render identically for a reader whose ArtaContrast setting we will never know.
 *
 * i18n. The mesh publishes rendered strings, so every proper noun, code and member-authored title
 * carries data-ay-skip="1" — a person's name and a work's title are not ours to translate.
 */

const GOLD = "#E8B923";
const BLUE_INK = "#1746DC"; // the real yin. NOT the #2352E8 sentinel — that is remapped by ATTRIBUTE
                            // selectors only, so it is right inside an SVG and wrong in a CSS border.

function fmtDate(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleDateString(uiLocale(), { year: "numeric", month: "long", day: "numeric" }) : "—";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ───────────────────────── the mark ─────────────────────────
 * The Foundation's own sigil — a gold A through a blue ring — struck once, quietly, at the head of
 * the document. Two strokes and a circle: it holds its shape at 64px on screen and at 20mm on paper,
 * and it needs no legend because it is the same mark that is on everything else the Foundation puts
 * its name to. */
function CertMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={cx("h-auto", className)} role="img" aria-label="ArtaQuest" xmlns="http://www.w3.org/2000/svg">
      <circle cx="48" cy="48" r="30" fill="none" stroke={BLUE_INK} strokeWidth="2.4" />
      <path d="M48 28 L61 68 M48 28 L35 68 M40.5 56 H55.5"
        fill="none" stroke={GOLD} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
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
      className="aq-sig-img block h-auto w-[136px] max-w-full object-contain"
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
  const Name = sample ? "h3" : "h1";
  return (
    <article className={cx("aq-cert aq-cert-plain relative mx-auto w-full max-w-4xl overflow-hidden rounded-card bg-space-1", sample && "select-none")}>
      {/* ONE rule. The old document had two nested frames and four corner ticks; a single hairline
          says "this is a document" just as clearly and leaves the name the loudest thing on it. */}
      {/* The side padding is a PERCENTAGE of the document's own width rather than `sm:px-14`
          (operator 2026-08-21). `sm:` is a 640px VIEWPORT query, and this certificate never gets the
          viewport: the app shell keeps a left rail and a 330px right column, so the page column it
          is drawn into is about 686px at a 1440px window, 570px at 1280, 410px at 1100 and 366px at
          1024. A flat 56px on each side was therefore spending 27% of the sheet at 1100 while still
          behaving as though the screen were wide. A percentage sizes to the box the document is
          actually in — about 55px at 686, 46px at 570, and floored at the original 28px once the
          sheet drops below ~350px — and print is unaffected, because @media print lays .aq-cert out
          at 100% of the page box, where 8% lands back on ~56px. */}
      <div className="relative px-[clamp(1.75rem,8%,3.5rem)] py-10 sm:py-14" style={{ border: "1px solid rgba(232,185,35,0.45)", borderRadius: "12px" }}>

        {sample && (
          <p className="aq-no-print absolute right-5 top-5 text-[9.5px] font-semibold uppercase tracking-[0.24em] text-ink-3">
            Sample
          </p>
        )}

        {/* ── head: the mark, then who issued it ── */}
        <div className="flex items-center gap-3">
          <CertMark className="w-11 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 text-ink">
              <span className="text-[15px] font-bold tracking-tight" data-ay-skip="1">ArtaQuest</span>
              <span className="text-[9px] font-semibold uppercase tracking-[0.26em] text-ink-2">Foundation</span>
            </div>
            <p className="mt-0.5 text-[9.5px] font-semibold uppercase tracking-[0.3em] text-yang">Certificate of Participation</p>
          </div>
        </div>

        {/* ── the record ── */}
        <p className="mt-11 text-[12px] italic leading-none text-ink-3">This records that</p>
        {/* On its own page the holder's name IS the document's heading, so it is the h1 that
            ClientNav focuses on navigation. Embedded as a specimen on /donate it must NOT be a
            second h1 competing with the page's own — it sits under that page's "What they
            receive" h2, so it drops to h3. */}
        <Name data-ay-skip="1" className="mt-3 font-display text-[clamp(1.8rem,4.6vw,2.9rem)] font-extrabold leading-[1.03] tracking-[-0.028em] text-ink">
          {cert.member}
        </Name>

        <p className="mt-5 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">
          entered the challenge{" "}
          <span className="font-bold text-yang" data-ay-skip="1">{cert.challenge}</span>{" "}
          with the work{" "}
          <span className="font-semibold text-ink" data-ay-skip="1">{cert.work}</span>
        </p>
        {/* kind and topic stay: they say what KIND of thing was made and in what field, which is
            the one piece of context a stranger reading this actually needs. The closing date does
            not — it was the same fact as the seal and the placement line, said a third time. */}
        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-ink-3">
          <span data-ay-skip="1">{cert.kind}</span> · <span data-ay-skip="1">{cert.topic}</span>
        </p>

        {/* Placement comes ONLY from the frozen settlement board, so nothing printed here can
            change afterwards. Until it closes there is simply no placement line — an entry that
            has not been judged is not a rank of zero. */}
        {placed ? (
          <p className="mt-6 text-[12.5px] font-semibold text-yang" data-ay-skip="1">
            {ordinal(cert.place)} of {cert.field} by hearts
            {cert.prize > 0 ? <span className="font-extrabold"> · ₳{cert.prize} won</span> : null}
          </p>
        ) : (
          <p className="mt-6 text-[12px] text-ink-3">
            {cert.settled ? "Judged when the challenge closed" : "The placement is added when the challenge closes"}
          </p>
        )}

        {/* ── one hairline, then the plates ── */}
        <div className="mt-11 h-px w-full" style={{ backgroundColor: "rgba(232,185,35,0.28)" }} aria-hidden />

        {/* auto-fit, not `sm:grid-cols-3` / `sm:grid-cols-2` (operator 2026-08-21). `sm:` asks the
            VIEWPORT, and the viewport is not what this document gets: inside the shell's content
            column the sheet has about 576px of usable width at 1440, 479px at 1280 and 344px at
            1100, so three tracks with a 40px gutter between them handed each plate 72px at 1100 —
            narrower than the founder's own signature line, and the plates collided. Each plate now
            asks for 10rem, which is what "Founder · ArtaQuest Foundation" measures at 9px with its
            tracking; that line is whitespace-nowrap by design, so it must never be given less. The
            row then takes as many tracks as fit — three at 1440 (~165px each), two at 1280 (~219px),
            one from 1100 down — with no breakpoint to be wrong. auto-fit also collapses the track a
            missing donor plate would have left empty, so an unsponsored certificate no longer needs
            a column count of its own. */}
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-10 gap-y-8 sm:items-end">
          {/* the Foundation's plate */}
          <div className="flex flex-col items-center sm:items-start">
            <FounderSignature />
            <div className="mt-1.5 w-full pt-2 text-center sm:text-start" style={{ borderTop: "1px solid rgba(232,185,35,0.28)" }}>
              <p className="text-[15.5px] font-semibold leading-none tracking-tight text-ink" data-ay-skip="1">Arash Ashrafnejad</p>
              <p className="mt-1 whitespace-nowrap text-[9px] tracking-[0.02em] text-ink-2">Founder · ArtaQuest Foundation</p>
            </div>
          </div>

          {/* the record line */}
          <div className="text-center">
            <p className="font-mono text-[12px] leading-none tracking-[0.14em] text-ink-2" data-ay-skip="1">{cert.code || "—"}</p>
            <p className="mt-1 text-[8.5px] uppercase tracking-[0.16em] text-ink-3">Verification code</p>
            <p className="mt-3 text-[11px] leading-none text-ink-2" data-ay-skip="1">{fmtDate(cert.entered_ts)}</p>
            <p className="mt-1 text-[8.5px] uppercase tracking-[0.16em] text-ink-3">Date entered</p>
          </div>

          {/* the DONOR's plate — present only when a donor actually paid this entry fee. When they
              did not, the grid collapses to two columns and there is no visible absence.
              The name is the donor's FULL name: /donate seeds this field from aq_profile_name(),
              not from the display handle it used to use — user_login on this platform is the local
              part of a member's email address, and this document gets printed. */}
          {cert.sponsored && (
            <div className="flex flex-col items-center sm:items-end sm:text-end">
              <span className="text-[9px] font-semibold uppercase tracking-[0.22em] text-yang">Entry fee given by</span>
              <p className="mt-1.5 text-[15.5px] font-semibold leading-tight tracking-tight text-ink" data-ay-skip={cert.donor ? "1" : undefined}>
                {cert.donor || "A friend of ArtaQuest"}
              </p>
              {cert.slice && <p className="mt-1 max-w-[16rem] text-[10px] leading-snug text-ink-2">for {cert.slice}</p>}
            </div>
          )}
        </div>

        <p className="mt-9 text-[9px] leading-relaxed tracking-[0.02em] text-ink-3">
          Issued by the ArtaQuest Foundation · anyone may confirm this certificate at{" "}
          <span data-ay-skip="1">artaquest.com/verify</span>
        </p>
      </div>
    </article>
  );
}
