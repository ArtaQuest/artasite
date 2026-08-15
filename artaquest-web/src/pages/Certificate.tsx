import { useEffect, useId, useState } from "react";
import { uiLocale, getCertificate, type Cert, type Medal } from "../lib/wp";
import { Button, LogoMark, StatusNote, cx } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};
const BASE = (import.meta.env.BASE_URL || "/");

// The learner's certificate for a course (route /certificate/?course=<id>). Data comes from the
// auth-gated BFF /aq/v1/certificate. Earned → a bespoke, printable certificate (ornamental frame,
// official seal, founder's signature, and — for a top-three quester — a struck medallion); not-earned
// → progress toward it; null (logged-out / bad course / error) → a sign-in prompt. "Print / Save as PDF"
// uses the browser's own print (with @media print CSS in index.css that isolates the .aq-cert).
export default function Certificate() {
  const course = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("course") || 0) : 0;
  const [cert, setCert] = useState<Cert | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!course) { setLoaded(true); return; }
    getCertificate(course).then(setCert).finally(() => setLoaded(true));
  }, [course]);
  useEffect(() => { document.title = "Certificate – ArtaQuest"; }, []);

  if (!loaded) return <StatusNote className="py-20">Loading…</StatusNote>;

  if (!cert) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-[24px] font-bold tracking-tight">Certificate unavailable</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">Sign in to view a certificate you’ve earned, or check the link.</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href={w.AQ_LOGIN_URL || "/login/"} size="lg">Sign in</Button>
          <Button variant="outline" href="/courses/" size="lg">Browse courses</Button>
        </div>
      </div>
    );
  }

  if (!cert.earned) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-[24px] font-bold tracking-tight">Not earned yet</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Watch every section of <strong className="text-ink">{cert.course}</strong> in full, post a reply to each, and upvote at least one other learner’s reply to earn your certificate.
          {typeof cert.progress === "number" && <> You’re at <strong className="text-ink">{cert.progress}%</strong>.</>}
        </p>
        <Button href={cert.course_url || "/courses/"} size="lg" className="mt-6">Continue the course</Button>
      </div>
    );
  }

  // The action bar — defined ONCE and rendered twice: in the desktop rail, and inline below lg where
  // the rail leaves the flow. aq-no-print stays on the card itself, so neither copy reaches the page.
  const actions = (
    <div className="aq-no-print flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">This certificate</h2>
      {/* Same order the action bar had: back first, then the primary action. */}
      <Button variant="ghost" href="/user-account/" className="h-9 w-full px-3 text-[13px]"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Account</Button>
      <Button onClick={() => window.print()} className="h-10 w-full px-5 text-[14px]">Print / Save as PDF</Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-5 py-8">
      {/* Below lg the rail is out of the flow, so the actions ride above the certificate, where the
          bar used to sit. Hidden at lg, so it costs no gap there. */}
      <RailInline>{actions}</RailInline>
      <WithRail label="This certificate" rail={actions}>
        {/* The certificate is deliberately narrower than the shell — the document is max-w-4xl. */}
        <div className="mx-auto max-w-4xl">
          <CertificateDoc cert={cert} />
          {cert.verify_url && (
            <p className="aq-no-print mt-4 text-center text-[12px] text-ink-3">
              Anyone can confirm this certificate is genuine at{" "}
              <a href={cert.verify_url} className="text-yin-light underline-offset-2 hover:underline" data-ay-skip="1">{verifyDisplay(cert.verify_url)}</a>
            </p>
          )}
        </div>
      </WithRail>
    </div>
  );
}

/* The verification URL shown to a human (host + path, query trimmed for readability). */
function verifyDisplay(url: string): string {
  return "artaquest.com" + url.split("?")[0];
}

const MEDAL_LABEL: Record<Exclude<Medal, "">, string> = { gold: "Gold", silver: "Silver", bronze: "Bronze" };

/* Ordinal place ("1st", "2nd", "3rd") for the podium caption. */
function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

/* ───────────────────────────── the certificate document ─────────────────────────────
 * The printable certificate itself — reused by the owner view (Certificate) and the public
 * authenticity view (Verify). Pure presentation; all colour lives in SVG fill/stroke attributes
 * (never CSS `color`) so the @media-print rule that forces text to black leaves the seal, medal,
 * frame and signature intact. */
export function CertificateDoc({ cert }: { cert: Cert }) {
  const date = cert.date_ts ? new Date(cert.date_ts * 1000) : null;
  const medal = (cert.medal || "") as Medal;
  return (
    <article className="aq-cert relative mx-auto max-w-4xl overflow-hidden rounded-card bg-space-2 p-2.5">
      {/* double ornamental frame: gold outer, fine blue inner */}
      <div className="relative rounded-[14px] border-2 p-1.5" style={{ borderColor: "rgba(232,185,35,0.55)" }}>
        <div className="relative overflow-hidden rounded-[10px] border bg-space-1 px-7 py-12 text-center sm:px-20 sm:py-16" style={{ borderColor: "rgba(35,82,232,0.45)" }}>
          {/* ambient glows (hidden in print) + faint guilloché watermark */}
          <div className="aq-glow pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-yang/10 blur-3xl" aria-hidden />
          <div className="aq-glow pointer-events-none absolute -bottom-28 -left-24 h-72 w-72 rounded-full bg-yin/10 blur-3xl" aria-hidden />
          <Guilloche />
          <CornerFlourish className="left-2 top-2" rotate={0} />
          <CornerFlourish className="right-2 top-2" rotate={90} />
          <CornerFlourish className="bottom-2 right-2" rotate={180} />
          <CornerFlourish className="bottom-2 left-2" rotate={270} />

          <div className="relative">
            {/* brand lockup */}
            <div className="mx-auto flex items-center justify-center gap-2.5 text-ink">
              <LogoMark className="h-8 w-8" />
              <span className="text-[18px] font-bold tracking-tight" data-ay-skip="1">ArtaQuest</span>
            </div>
            <p className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.34em] text-ink-2">ArtaQuest Foundation</p>

            {/* eyebrow, flanked by hairlines */}
            <div className="mx-auto mt-10 flex max-w-xs items-center justify-center gap-3">
              <span className="h-px flex-1 bg-yang/30" aria-hidden />
              <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.4em] text-yang">Certificate of Completion</span>
              <span className="h-px flex-1 bg-yang/30" aria-hidden />
            </div>

            <p className="mt-9 text-[13px] italic leading-none text-ink-3">This certifies that</p>
            <h1 data-ay-skip="1" className="mt-3.5 font-display text-[clamp(2.1rem,5.2vw,3.1rem)] font-extrabold leading-[1.04] tracking-[-0.025em] text-ink">{cert.learner}</h1>
            <div className="mx-auto mt-4 h-px w-48 max-w-[68%] bg-gradient-to-r from-transparent via-yang/55 to-transparent" aria-hidden />
            <p className="mt-5 text-[13px] italic leading-none text-ink-3">has successfully completed the course</p>
            <p className="mx-auto mt-3 max-w-2xl text-[clamp(1.25rem,3vw,1.7rem)] font-bold leading-[1.25] tracking-tight text-yang" data-ay-skip="1">{cert.course}</p>

            {medal && (
              <div className="mt-9 flex flex-col items-center">
                <Medallion medal={medal} rank={cert.rank || 0} />
                <p className="mt-3.5 text-[11px] font-semibold uppercase tracking-[0.3em] text-yang" data-ay-skip="1">
                  {MEDAL_LABEL[medal as Exclude<Medal, "">]} Quester
                </p>
                <p className="mt-1.5 text-[12px] text-ink-2" data-ay-skip="1">
                  {ordinal(cert.rank || 0)} place · {cert.votes ?? 0} peer {cert.votes === 1 ? "vote" : "votes"}
                </p>
                {!!(cert.reward || cert.prize) && (
                  <span className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-yang/40 bg-yang/10 px-3.5 py-1 text-[11.5px] font-semibold tracking-wide text-yang" data-ay-skip="1">
                    ₳ {cert.reward || cert.prize} {cert.reward ? "awarded" : "prize"}
                  </span>
                )}
              </div>
            )}

            {/* footer: signature · verification */}
            <div className="mx-auto mt-12 grid max-w-xl grid-cols-1 items-end gap-x-8 gap-y-9 border-t border-line pt-8 sm:grid-cols-2">
              {/* signature block — signature, name and title kept to a similar line length */}
              <div className="flex flex-col items-center sm:items-start">
                <div className="flex w-fit flex-col items-center sm:items-start">
                  <FounderSignature />
                  <div className="mt-1.5 w-full border-t border-line/70 pt-2 text-center sm:text-start">
                    <p className="text-[19px] font-semibold leading-none tracking-tight text-ink" data-ay-skip="1">Arash Ashrafnejad</p>
                    <p className="mt-1 whitespace-nowrap text-[10px] tracking-[0.01em] text-ink-2">Founder · ArtaQuest Foundation</p>
                  </div>
                </div>
              </div>

              <div className="text-center sm:text-end">
                <p className="text-[12.5px] leading-none text-ink-2" data-ay-skip="1">
                  {date ? <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString(uiLocale(), { year: "numeric", month: "long", day: "numeric" })}</time> : "—"}
                </p>
                <p className="mt-1 text-[9.5px] uppercase tracking-[0.14em] text-ink-2">Date completed</p>
                <p className="mt-3.5 font-mono text-[12.5px] tracking-[0.12em] leading-none text-ink-2" data-ay-skip="1">{cert.code || "—"}</p>
                <p className="mt-1 text-[9.5px] uppercase tracking-[0.14em] text-ink-2">Verification code</p>
              </div>
            </div>

            <p className="mx-auto mt-8 max-w-md text-[10px] leading-relaxed tracking-[0.02em] text-ink-2">
              Issued by the ArtaQuest Foundation · verify the authenticity of this certificate at artaquest.com/verify
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

/* ───────────────────────── founder's signature ─────────────────────────
 * Loads the founder's real handwritten signature from public/signature.svg (then .png) the moment
 * it exists; until then renders a tasteful cursive stand-in so the certificate is never unfinished.
 * Drop your scan at artaquest-web/public/signature.svg (or .png) — dark ink on a transparent
 * background works best on the light printed page — and it appears automatically, no code change. */
function FounderSignature() {
  const [stage, setStage] = useState<0 | 1 | 2>(0); // 0 = try .png, 1 = try .svg, 2 = cursive stand-in
  if (stage < 2) {
    // The signature is clean black ink on transparent, so it reads as dark on the printed white page;
    // on the dark on-screen certificate we invert it to light (print:invert-0 restores the ink for PDF).
    return (
      <img
        src={`${BASE}signature.${stage === 0 ? "png" : "svg"}`}
        alt="Arash Ashrafnejad signature"
        className="block h-auto w-[158px] max-w-full object-contain invert print:invert-0"
        data-ay-skip="1"
        onError={() => setStage((s) => (s + 1) as 0 | 1 | 2)}
      />
    );
  }
  return (
    <span data-ay-skip="1" aria-label="Arash Ashrafnejad signature" className="aq-sig block text-[22px] leading-none text-ink">
      Ashrafnejad
    </span>
  );
}

/* ───────────────────────── struck podium medallion ─────────────────────────
 * A ribboned, metal-struck medal — gold / silver / bronze — pinned with brand-blue ribbon tails.
 * The course's top-three questers (peer-vote winners) wear it on their certificate. */
const METAL: Record<Exclude<Medal, "">, { hi: string; mid: string; lo: string; ring: string }> = {
  gold:   { hi: "#FFE9A8", mid: "#E8B923", lo: "#8A6E12", ring: "#C49B1A" },
  silver: { hi: "#F4F6F9", mid: "#C7CDD6", lo: "#7C8593", ring: "#9AA3AE" },
  bronze: { hi: "#F0C9A0", mid: "#C77B3C", lo: "#7A431B", ring: "#9C5A28" },
};
function Medallion({ medal, rank }: { medal: Medal; rank: number }) {
  const id = useId();
  const m = METAL[(medal || "gold") as Exclude<Medal, "">];
  return (
    <svg viewBox="0 0 100 120" className="h-[112px] w-auto" role="img" aria-label={`${medal} medal`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={`${id}-d`} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor={m.hi} />
          <stop offset="55%" stopColor={m.mid} />
          <stop offset="100%" stopColor={m.lo} />
        </radialGradient>
      </defs>
      {/* ribbon tails (behind the disc) */}
      <path d="M37 60 L52 60 L52 114 L44.5 103 L37 114 Z" fill="#2352E8" />
      <path d="M48 60 L63 60 L63 114 L55.5 103 L48 114 Z" fill="#1A3DB5" />
      {/* disc */}
      <circle cx="50" cy="42" r="33" fill={m.lo} opacity="0.45" />
      <circle cx="50" cy="40" r="33" fill={`url(#${id}-d)`} stroke={m.ring} strokeWidth="2.5" />
      <circle cx="50" cy="40" r="26.5" fill="none" stroke={m.lo} strokeWidth="1.3" strokeOpacity="0.55" strokeDasharray="1.5 2.4" />
      {/* star + rank numeral */}
      <path d="M50 23 L52.7 30.1 L60.3 30.4 L54.3 35 L56.4 42.3 L50 38 L43.6 42.3 L45.7 35 L39.7 30.4 L47.3 30.1 Z" fill={m.hi} stroke={m.lo} strokeWidth="0.8" strokeLinejoin="round" />
      <text x="50" y="58" textAnchor="middle" fontFamily="Montserrat, ui-serif, Georgia, serif" fontSize="19" fontWeight="800" fill={m.lo}>{rank || ""}</text>
    </svg>
  );
}

/* A corner ornament; rotate it for each of the four corners. Gold via fixed fill so it survives print. */
function CornerFlourish({ className, rotate }: { className: string; rotate: number }) {
  const gold = "#C49B1A";
  return (
    <svg className={cx("pointer-events-none absolute h-10 w-10", className)} viewBox="0 0 40 40" fill="none" aria-hidden style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M3 3 H24 M3 3 V24" stroke={gold} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M7 7 H17 M7 7 V17" stroke={gold} strokeWidth="0.9" strokeOpacity="0.6" strokeLinecap="round" />
      <circle cx="3" cy="3" r="1.6" fill={gold} />
    </svg>
  );
}

/* A faint concentric guilloché watermark behind the text — the engine-turned look of secure stationery. */
function Guilloche() {
  return (
    <svg className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2 opacity-[0.05]" viewBox="0 0 400 400" fill="none" aria-hidden>
      <g stroke="#E8B923" strokeWidth="1">
        {[150, 130, 110, 90, 70].map((r) => <circle key={r} cx="200" cy="200" r={r} />)}
      </g>
      <g stroke="#2352E8" strokeWidth="1">
        {[160, 140, 120, 100, 80].map((r) => <circle key={r} cx="200" cy="200" r={r} strokeOpacity="0.8" />)}
      </g>
    </svg>
  );
}
