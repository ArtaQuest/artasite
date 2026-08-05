import { useEffect, useRef } from "react";
import { Button, Card } from "../components/ui";

/* ArtaMic — the offering page at /artamic.
   ArtaMic adds a microphone to macOS that removes the room and the echo, and tunes
   itself to the speaker's own voice from a twenty second recording. Every figure on
   this page is measured on the machine it was built on, not estimated. */

const FIGURES: Array<{ value: string; caption: string }> = [
  { value: "−11.3 dB", caption: "noise removed, while the voice drops only 0.2 dB" },
  { value: "11.5 ms", caption: "added by the processing chain" },
  { value: "0.26 %", caption: "of one core on an M2 MacBook Air" },
  { value: "0", caption: "settings to adjust" },
];

/* Who performs each stage. Echo cancellation is Apple's and we say so — the app
   asks for it and reports whether it is on, and never claims to do it itself. */
const PATH: Array<{ who: string; ours: boolean; title: string; body: string }> = [
  {
    who: "macOS", ours: false, title: "Echo cancellation",
    body: "The system removes whatever your speakers are playing, so the far end never hears itself. We ask for it and report whether it is on.",
  },
  {
    who: "ArtaMic", ours: true, title: "Noise suppression",
    body: "Wiener gains on a 512-point spectrum, with the noise floor tracked by minimum statistics so a sustained sound is learned as noise and a voice is not.",
  },
  {
    who: "ArtaMic", ours: true, title: "Your profile",
    body: "A corrective tone curve from your own long-term spectrum, applied at half strength and capped at ±6 dB — a full correction makes every voice sound like the same average voice.",
  },
  {
    who: "ArtaMic", ours: true, title: "Gate, compressor, limiter",
    body: "Quiet between phrases, even across loud and soft passages, and a ceiling that inter-sample peaks cannot breach.",
  },
  {
    who: "Zoom · Meet · Teams", ours: false, title: "ArtaMic",
    body: "Appears in the microphone list like any other device. Nothing else changes.",
  },
];

/* Said plainly, because a product that overclaims about noise is easy to catch out. */
const LIMITS: Array<{ title: string; body: string }> = [
  {
    title: "Other people talking is the hard case",
    body: "Steady sound — fans, traffic, hum, room tone — is removed well. A second conversation nearby is speech too, and this kind of processing cannot reliably tell it from yours. In a busy room, turn on the macOS Voice Isolation mic mode as well; the app links straight to it.",
  },
  {
    title: "A Bluetooth headset is a poor microphone",
    body: "Using one forces the headset profile, which runs the microphone at 16 kHz and drops your music quality at the same time. The built-in microphone with Bluetooth headphones sounds better, and ArtaMic defaults to that pairing.",
  },
  {
    title: "It adds about 21 ms",
    body: "Microphone to ArtaMic, before your meeting app's own buffering. Normal for a virtual microphone and well under what a network adds, but it is not zero.",
  },
  {
    title: "Nothing leaves your Mac",
    body: "The analysis is a few milliseconds of arithmetic on your own machine. There is no account, no upload, and no server to trust.",
  },
];

/* The signal itself, drawn live: the noisy input in blue against the cleaned
   output in gold. It is the most characteristic thing this product does, so it
   opens the page rather than a stock photograph of somebody wearing a headset. */
function Scope() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Canvas 2D takes a COLOUR STRING; `var(--color-yang)` is not one and is silently ignored, which
    // is why a hex literal used to sit on the line after it doing the actual work. Resolve the live
    // tokens instead, so the scope follows the theme and the contrast slider like everything else —
    // and so gold and blue here stay the pair that sums to white rather than a frozen copy of it.
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const yang = token("--color-yang", "#E8B923");
    const yin = token("--color-yin", "#1746DC");
    const W = canvas.width;
    const H = canvas.height;
    const mid = H / 2;
    let seed = 1;
    let raf = 0;

    const noise = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 2147483648 - 1;
    };
    // Speech is not continuous, and the gaps are exactly where the noise floor
    // being removed becomes visible.
    const envelope = (x: number, t: number) =>
      Math.pow(Math.max(0, Math.sin(x * 1.7 + t * 0.55)), 0.7) *
      (0.45 + 0.55 * Math.abs(Math.sin(x * 11 + t * 2.1)));
    const voice = (x: number, t: number) =>
      Math.sin(x * 47 + t * 6) * 0.55 +
      Math.sin(x * 96 + t * 5) * 0.28 +
      Math.sin(x * 151 + t * 7) * 0.17;

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);

      ctx.beginPath();
      for (let px = 0; px <= W; px += 2) {
        const x = (px / W) * 6.2;
        const e = envelope(x, t);
        const y = mid + (voice(x, t) * e + noise() * 0.3) * (H * 0.3);
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.strokeStyle = yin;
      ctx.globalAlpha = 0.85; // the noisy input sits behind the cleaned output
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.beginPath();
      for (let px = 0; px <= W; px += 2) {
        const x = (px / W) * 6.2;
        const e = envelope(x, t);
        const y = mid + voice(x, t) * e * (e > 0.1 ? 1 : 0) * (H * 0.3);
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = yang;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(W, mid);
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    if (reduced) {
      draw(0);
      return;
    }
    let start: number | null = null;
    const frame = (ts: number) => {
      if (start === null) start = ts;
      draw((ts - start) / 1000);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="am-scope">
      <canvas
        ref={ref}
        width={1600}
        height={304}
        aria-label="A noisy waveform entering ArtaMic and the cleaned voice leaving it"
      />
      <div className="am-legend">
        <span><i style={{ background: "#1746DC" }} /> what the microphone hears</span>
        <span><i style={{ background: "#E8B923" }} /> what the meeting hears</span>
      </div>
    </div>
  );
}

export default function ArtaMic() {
  return (
    <div className="am-page">
      <style>{`
        .am-page { max-width: 940px; margin: 0 auto; padding: 0 clamp(20px,5vw,56px) 64px; }
        .am-page h1 { font-size: clamp(2.1rem,5.5vw,3.4rem); line-height: 1.06; letter-spacing: -.015em; text-wrap: balance; margin: 0; }
        .am-page h2 { font-size: clamp(1.4rem,3vw,1.95rem); line-height: 1.16; text-wrap: balance; margin: 0; }
        .am-page h3 { font-size: 1rem; margin: 0; color: var(--color-yang, #E8B923); }
        .am-page p { margin: 0; max-width: 66ch; line-height: 1.65; }
        .am-hero { display: flex; flex-direction: column; gap: 24px; padding: clamp(28px,6vh,60px) 0 clamp(30px,6vh,56px); }
        .am-hero h1 em { font-style: normal; color: var(--color-yang, #E8B923); }
        .am-lede { font-size: clamp(1rem,2vw,1.18rem); opacity: .72; }
        .am-eyebrow { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .70rem;
                      letter-spacing: .16em; text-transform: uppercase; opacity: .42; }
        .am-scope { border: 1px solid rgba(255,255,255,.10); border-radius: 14px; overflow: hidden;
                    background: linear-gradient(180deg, rgba(255,255,255,.035), transparent); }
        .am-scope canvas { display: block; width: 100%; height: 152px; }
        .am-legend { display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 10px 16px 13px;
                     border-top: 1px solid rgba(255,255,255,.10);
                     font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; opacity: .45; }
        .am-legend span { display: inline-flex; align-items: center; gap: 7px; }
        .am-legend i { width: 16px; height: 2px; border-radius: 2px; display: inline-block; }
        .am-cta { display: flex; flex-wrap: wrap; gap: 12px; }
        .am-figures { display: grid; gap: 1px; grid-template-columns: repeat(auto-fit, minmax(158px,1fr));
                      background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.10);
                      border-radius: 12px; overflow: hidden; }
        .am-figure { background: var(--color-space-raised, #06121E); padding: 18px; display: flex; flex-direction: column; gap: 3px; }
        .am-figure b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums;
                       font-size: 1.4rem; font-weight: 500; color: var(--color-yang, #E8B923); letter-spacing: -.02em; }
        .am-figure span { font-size: .78rem; opacity: .66; line-height: 1.4; }
        .am-section { display: flex; flex-direction: column; gap: 16px; padding: clamp(36px,7vh,72px) 0 0; }
        .am-path { display: flex; flex-direction: column; gap: 2px; }
        .am-step { display: grid; grid-template-columns: 132px 1fr; gap: 18px; align-items: baseline;
                   padding: 15px 16px; background: var(--color-space-raised, #06121E);
                   border: 1px solid rgba(255,255,255,.10); }
        .am-step:first-child { border-radius: 10px 10px 0 0; }
        .am-step:last-child { border-radius: 0 0 10px 10px; }
        .am-step p { font-size: .92rem; opacity: .72; }
        .am-who { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .68rem;
                  letter-spacing: .1em; text-transform: uppercase; }
        .am-ours { color: var(--color-yang, #E8B923); }
        .am-theirs { color: #3f6bf0; }
        .am-limits { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(258px,1fr)); }
        .am-limit { display: flex; flex-direction: column; gap: 6px; }
        .am-limit p { font-size: .88rem; opacity: .70; }
        .am-code { margin: 0; padding: 16px 18px; overflow-x: auto; border-radius: 10px;
                   background: var(--color-space-raised, #06121E); border: 1px solid rgba(255,255,255,.10);
                   font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; line-height: 1.8; }
        .am-foot { font-size: .82rem; opacity: .45; padding-top: 8px; }
        @media (max-width: 560px) { .am-step { grid-template-columns: 1fr; gap: 5px; } }
        @media (prefers-reduced-motion: reduce) { .am-page * { animation: none !important; transition: none !important; } }
      `}</style>
      <section className="am-hero">
        <p className="am-eyebrow">ArtaMic · macOS</p>
        <h1>
          A microphone that <em>measures your room</em> instead of asking you about it
        </h1>
        <p className="am-lede">
          ArtaMic adds an input device to macOS. Pick it in Zoom, Meet or Teams and they hear
          your voice without the fan, the street or the echo. Twenty seconds of calibration —
          five of your room, fifteen of you talking — and it tunes itself to both.
        </p>

        <Scope />

        <div className="am-cta">
          <Button href="https://github.com/ArtaQuest/artamic">Get ArtaMic</Button>
          <Button variant="ghost" href="https://github.com/ArtaQuest/artamic#calibrating">
            How calibration works
          </Button>
        </div>
      </section>

      <div className="am-figures">
        {FIGURES.map((f) => (
          <div className="am-figure" key={f.caption}>
            <b>{f.value}</b>
            <span>{f.caption}</span>
          </div>
        ))}
      </div>

      <section className="am-section">
        <p className="am-eyebrow">Why there are no settings</p>
        <h2>Every value it needs is measured, not guessed</h2>
        <p>
          A slider for the noise gate is a question: <em>at what level should this stop being
          your voice?</em> You cannot answer that, and neither can we — but a microphone can.
          During calibration ArtaMic measures your room's noise floor, your pitch range, your
          speaking level and the shape of your voice, then sets the rumble filter, the gate,
          the suppression depth, the compressor and the tone curve from those measurements.
        </p>
        <p>
          Move to a café and the honest answer is not to reach for a slider. It is to measure
          again. Everything it derived stays visible in the app, read-only, so nothing is
          hidden — just nothing is your job.
        </p>
      </section>

      <section className="am-section">
        <p className="am-eyebrow">The signal path</p>
        <h2>What is ours, and what is Apple's</h2>
        <div className="am-path">
          {PATH.map((step) => (
            <div className="am-step" key={step.title}>
              <span className={step.ours ? "am-who am-ours" : "am-who am-theirs"}>{step.who}</span>
              <p>
                <strong>{step.title}.</strong> {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="am-section">
        <p className="am-eyebrow">Worth knowing before you install</p>
        <h2>What it does not do</h2>
        <div className="am-limits">
          {LIMITS.map((l) => (
            <Card key={l.title} className="am-limit">
              <h3>{l.title}</h3>
              <p>{l.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="am-section">
        <p className="am-eyebrow">Installing</p>
        <h2>Build it, open it, press one button</h2>
        <pre className="am-code">
{`git clone https://github.com/ArtaQuest/artamic
cd artamic
Scripts/build.sh
open build/ArtaMic.app`}
        </pre>
        <p>
          The first launch shows a single <strong>Set up ArtaMic</strong> button. macOS asks
          for your password once — the audio driver has to live in a system folder, which is
          the only place CoreAudio will load it from — and that is the whole installation. No
          terminal afterwards, and the app can remove the device again from the same window.
        </p>
        <p className="am-foot">
          Free and open source under the MIT licence, from the ArtaQuest Foundation.
          Built and measured on an M2 MacBook Air running macOS 26.
        </p>
      </section>
    </div>
  );
}
