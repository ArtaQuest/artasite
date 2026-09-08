import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CastRow, CastSide } from "../../lib/api";
import { firstName, hookLines, timelineRows, type PreviewData } from "../../lib/cast-frame";
export type { PreviewData };

/**
 * The episode frame and the thumbnail, drawn LIVE from what the couple types.
 *
 * These are the YouTube kit's two boards (the 1920×1080 frame with the couple side by side on top
 * and the host below; the 1280×720 thumbnail with the two portraits either side of the hook),
 * rendered at their real size and scaled to whatever width the page gives them, so every pixel
 * measurement in the kit holds and the editor's export is what the couple saw. Everything is inline
 * style on purpose: this is a picture of a video frame, not a page, so it keeps the kit's own
 * colours (space #010C17, gold #E8B923, blue #1746DC, the three inks) and never the theme's tokens —
 * a light theme must not turn the episode frame white.
 *
 * ⚠️ `data-ay-skip="1"` on every member-authored word: names, subtitles, places, milestone labels.
 * The i18n mesh persists what it finds into the public translations table.
 */

const INK1 = "#F4F4F5", INK2 = "#A6A8B0", INK3 = "#8B8E98";
const SPACE = "#010C17", WINDOW = "#0C1E32", GOLD = "#E8B923", BLUE = "#1746DC";
const DISPLAY = 'Montserrat, var(--font-display), "Helvetica Neue", Arial, sans-serif';
const BODY = 'Inter, var(--font-sans), "Helvetica Neue", Arial, sans-serif';

/** Renders `w × h` design pixels into whatever width the parent gives, by transform — the kit's
 *  measurements stay literal. Height follows the aspect ratio, so nothing below it moves. */
export function Scaled({ w, h, children, className, label }: { w: number; h: number; children: ReactNode; className?: string; label: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  const s = width > 0 ? width / w : 0;
  return (
    <div ref={box} role="img" aria-label={label} className={className}
      style={{ position: "relative", width: "100%", aspectRatio: `${w} / ${h}`, overflow: "hidden", background: SPACE, borderRadius: 12 }}>
      <div aria-hidden style={{ position: "absolute", left: 0, top: 0, width: w, height: h, transform: `scale(${s})`, transformOrigin: "0 0", visibility: s > 0 ? "visible" : "hidden" }}>
        {children}
      </div>
    </div>
  );
}

/** The kit's placeholder bust, for a window with no photograph yet. */
function Bust({ w, h, opacity = 0.25 }: { w: number; h: number; opacity?: number }) {
  return (
    <svg viewBox="0 0 912 513" width={w} height={h} preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", left: 0, top: 0, display: "block" }} aria-hidden>
      <g fill={INK3} opacity={opacity}>
        <ellipse cx="456" cy="235" rx="105" ry="140" />
        <path d="M416 360 L496 360 L496 410 C540 450 760 470 820 513 L92 513 C152 470 372 450 416 410 Z" />
      </g>
    </svg>
  );
}

function Photo({ src, w, h, grey, position }: { src: string; w: number; h: number; grey?: boolean; position?: string }) {
  if (!src) return <Bust w={w} h={h} />;
  return (
    <img src={src} alt="" draggable={false}
      style={{ position: "absolute", left: 0, top: 0, width: w, height: h, objectFit: "cover", objectPosition: position || "50% 35%", display: "block", filter: grey ? "grayscale(1)" : undefined }} />
  );
}

/** The lower-third: a 10px blue bar, then two hugging plates — the name over the one-line subtitle.
 *  The name steps from 60/64 to 48/52 and wraps when it cannot fit the 858px maximum; the subtitle
 *  never wraps. Names never truncate. */
function LowerThird({ side, fallback }: { side: CastSide; fallback: string }) {
  const name = (side.name || "").trim() || fallback;
  const two = name.length > 22;
  return (
    <div style={{ position: "absolute", left: 0, bottom: 0, display: "flex", alignItems: "stretch", maxWidth: 912 }}>
      <div style={{ flex: "none", width: 10, background: BLUE }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
        <div data-ay-skip="1" style={{ background: "rgba(0,0,0,0.80)", color: INK1, boxSizing: "border-box", fontFamily: DISPLAY, fontWeight: 700,
          fontSize: two ? 48 : 60, lineHeight: two ? "52px" : "64px", letterSpacing: "-0.01em", padding: "10px 24px 10px 20px",
          maxWidth: 858 + 44, overflowWrap: "anywhere", textAlign: "left", whiteSpace: two ? "normal" : "nowrap" }}>
          {name}
        </div>
        {side.subtitle?.trim() && (
          <div data-ay-skip="1" style={{ background: "rgba(0,0,0,0.80)", color: INK1, boxSizing: "border-box", fontFamily: BODY, fontWeight: 600,
            fontSize: 44, lineHeight: "48px", letterSpacing: "0.005em", padding: "6px 24px 6px 20px", whiteSpace: "nowrap", maxWidth: 902, overflow: "hidden" }}>
            {side.subtitle.trim()}
          </div>
        )}
      </div>
    </div>
  );
}

/** One spouse's timeline: a vertical list on a 6px rail at the frame's outer edge, 64px a row, the
 *  year beside the rail and the label beyond it. The rail is gold as far as the story has come (the
 *  cursor rests on the wedding), ink-3 ahead. Hers is mirrored: it hangs from the right edge. */
function Timeline({ rows, right, top, cursorAt }: { rows: CastRow[]; right?: boolean; top: number; cursorAt: number }) {
  const n = rows.length;
  if (!n) return null;
  const railH = Math.max(0, (n - 1) * 64);
  const goldH = Math.max(0, cursorAt * 64);
  const edge: CSSProperties = right ? { right: 9 } : { left: 9 };
  return (
    <div style={{ position: "absolute", top, width: 576, height: n * 64, left: right ? 1312 : 32 }}>
      <div style={{ position: "absolute", top: 32, width: 6, height: railH, background: INK3, ...edge }} />
      <div style={{ position: "absolute", top: 32, width: 6, height: goldH, background: GOLD, ...edge }} />
      {rows.map((r, i) => {
        const past = i < cursorAt, now = i === cursorAt;
        const color = now ? INK1 : past ? INK2 : INK3;
        return (
          <div key={i} style={{ position: "absolute", left: 0, top: i * 64, width: 576, height: 64, display: "flex", alignItems: "center", gap: 16,
            whiteSpace: "nowrap", color, flexDirection: right ? "row-reverse" : "row", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 29, width: i <= cursorAt ? (now ? 34 : 24) : 24, height: 6, background: i <= cursorAt ? GOLD : INK3, ...(right ? { right: 0 } : { left: 0 }) }} />
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 32, lineHeight: "36px", letterSpacing: "-0.01em", ...(right ? { marginRight: 40 } : { marginLeft: 40 }) }}>{r.y}</div>
            <div data-ay-skip="1" style={{ fontFamily: BODY, fontWeight: 500, fontSize: 28, lineHeight: "36px" }}>{r.l}</div>
          </div>
        );
      })}
    </div>
  );
}

/** The episode frame, 1920 × 1080. */
export function CastFrame({ data, className }: { data: PreviewData; className?: string }) {
  const rowsA = useMemo(() => timelineRows(data.a, data.married_y), [data.a, data.married_y]);
  const rowsB = useMemo(() => timelineRows(data.b, data.married_y), [data.b, data.married_y]);
  const most = Math.max(rowsA.length, rowsB.length, 1);
  // Both lists take one top, centred on the bottom band with the host: 549 + (513 − rows×64) / 2.
  const top = Math.round(549 + (513 - most * 64) / 2);
  const cursorA = Math.max(0, rowsA.findIndex((r) => r.l === "Married"));
  const cursorB = Math.max(0, rowsB.findIndex((r) => r.l === "Married"));
  const win: CSSProperties = { position: "absolute", width: 912, height: 513, borderRadius: 16, overflow: "hidden", background: WINDOW };
  return (
    <Scaled w={1920} h={1080} className={className} label="The episode frame, drawn from your details">
      <div style={{ position: "absolute", inset: 0, background: SPACE }}>
        <div style={{ ...win, left: 32, top: 18 }}>
          <Photo src={data.a.photo} w={912} h={513} />
          <LowerThird side={data.a} fallback="Your name" />
        </div>
        <div style={{ ...win, left: 976, top: 18 }}>
          <Photo src={data.b.photo} w={912} h={513} />
          <LowerThird side={data.b} fallback="Your partner’s name" />
        </div>
        <div style={{ position: "absolute", left: 640, top: 625, width: 640, height: 360, borderRadius: 16, overflow: "hidden", background: WINDOW }}>
          {data.hostPhoto ? <Photo src={data.hostPhoto} w={640} h={360} position="50% 30%" /> : <Bust w={640} h={360} />}
        </div>
        <Timeline rows={rowsA} top={top} cursorAt={cursorA} />
        <Timeline rows={rowsB} top={top} cursorAt={cursorB} right />
      </div>
    </Scaled>
  );
}

/** The ArtaQuest mark, as the thumbnail carries it: a gold A through a blue ring, 250px. */
function Mark({ size = 250 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -9 118 118" width={size} height={size} fill="none" role="img" aria-label="ArtaQuest" style={{ display: "block", flex: "none" }}>
      <defs>
        <mask id="aq-cast-moat">
          <rect x="-9" y="-9" width="118" height="118" fill="#fff" />
          <path d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z" fill="#000" stroke="#000" strokeWidth="7" strokeLinejoin="round" />
        </mask>
      </defs>
      <circle cx="50" cy="50" r="41.6" fill="none" stroke={BLUE} strokeWidth="11.66" mask="url(#aq-cast-moat)" />
      <path fill={GOLD} fillRule="evenodd" d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67ZM50 34.55L38.57 59.3L61.43 59.3Z" />
    </svg>
  );
}

/** The thumbnail, 1280 × 720: the two portraits either side, desaturated, each face bleeding off
 *  its own outer edge, and the hook column on the bare ground between them, over the mark. */
export function CastThumb({ data, className }: { data: PreviewData; className?: string }) {
  const [l1, l2, l3] = hookLines(data.married_y);
  const who = [firstName(data.a.name), firstName(data.b.name)].filter(Boolean).join(" & ");
  const hook: CSSProperties = { fontFamily: DISPLAY, fontWeight: 800, fontSize: 92, lineHeight: "90px", letterSpacing: "-0.025em", color: INK1, textTransform: "uppercase" };
  const crop: CSSProperties = { position: "absolute", top: 0, width: 380, height: 720, background: WINDOW, overflow: "hidden" };
  return (
    <Scaled w={1280} h={720} className={className} label="The thumbnail, drawn from your details">
      <div style={{ position: "absolute", inset: 0, background: SPACE }}>
        <div style={{ ...crop, left: 0 }}>
          <Photo src={data.a.photo} w={380} h={720} grey position="60% 30%" />
        </div>
        <div style={{ ...crop, left: 900 }}>
          <Photo src={data.b.photo} w={380} h={720} grey position="40% 30%" />
        </div>
        <div style={{ position: "absolute", left: 380, top: 0, width: 520, height: 720, background: SPACE, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", boxSizing: "border-box", padding: "36px 20px 0 20px" }}>
          <div style={hook}>{l1}</div>
          <div style={hook}>{l2}</div>
          <div style={hook}>{l3}</div>
          <div data-ay-skip="1" style={{ marginTop: 14, fontFamily: DISPLAY, fontWeight: 700, fontSize: 30, lineHeight: "36px", letterSpacing: "0.02em", color: INK2, textTransform: "uppercase", textAlign: "center", maxWidth: 480, overflowWrap: "anywhere" }}>
            {who || "You & your partner"}
          </div>
          <div style={{ marginTop: 28 }}><Mark /></div>
        </div>
      </div>
    </Scaled>
  );
}
