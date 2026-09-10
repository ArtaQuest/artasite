import { useEffect, useState } from "react";
import { type LookSettings, lookSettings, lookStats, lookSupported, onLook, setLook } from "../../lib/look";

/**
 * APPEARANCE — the four switches, in the order a person reaches for them.
 *
 * Touch up · Low light · Portrait lighting · Auto-framing. Each is a setting about this member on
 * this browser (lib/look), applied live to the dressed camera track wherever it is showing — the
 * mirror before the door, the tile in the call, the recorder — so there is nothing to confirm and
 * nothing to restart. The panel is the same component in both places.
 *
 * Under the switches, ONE quiet line says what the look is costing and what the engine has decided
 * about it. The engine turns itself down on a device that cannot afford it (lib/look's Governor);
 * when it has, this is where the member finds out why their touch-up stopped, rather than wondering.
 */
export function Appearance({ track }: { track: MediaStreamTrack | null | undefined }) {
  const [s, setS] = useState<LookSettings>(lookSettings);
  useEffect(() => onLook(setS), []);
  const [stat, setStat] = useState(() => lookStats(track));
  useEffect(() => {
    setStat(lookStats(track));
    if (!track) return;
    const iv = window.setInterval(() => setStat(lookStats(track)), 1000);
    return () => window.clearInterval(iv);
  }, [track]);
  if (!lookSupported()) {
    return <p className="text-[12px] text-ink-3">Your browser can’t adjust the picture — the camera goes out as it is.</p>;
  }
  const row = "flex items-center justify-between gap-3 py-2";
  const lbl = "text-[13px] text-ink";
  return (
    <div className="divide-y divide-line" aria-label="Appearance">
      <div className={row}>
        <span className={lbl}>Touch up my appearance</span>
        <Switch on={s.touch > 0} onChange={(on) => setLook({ touch: on ? 0.6 : 0 })} label="Touch up my appearance" />
      </div>
      {s.touch > 0 && (
        <Slider value={s.touch} onChange={(v) => setLook({ touch: Math.max(0.05, v) })} label="Touch-up strength" />
      )}
      <div className={row}>
        <span className={lbl}>Adjust for low light</span>
        <Switch on={s.light !== "off"} onChange={(on) => setLook({ light: on ? "auto" : "off" })} label="Adjust for low light" />
      </div>
      {s.light !== "off" && (
        <div className="py-2">
          <select value={s.light} onChange={(e) => setLook({ light: e.target.value === "manual" ? "manual" : "auto" })}
            aria-label="How the low-light adjustment is decided"
            className="h-9 rounded-field border border-line bg-space-1 px-2.5 text-[13px] text-ink">
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </select>
          {s.light === "manual" && (
            <Slider value={s.lightLevel} onChange={(v) => setLook({ lightLevel: v })} label="Low-light level" />
          )}
        </div>
      )}
      <div className={row}>
        <span className={`${lbl} inline-flex items-center gap-1.5`}>Portrait lighting
          <Info text="Lifts the light on your face and softens the room around it, like a lamp in front and a dimmer behind" />
        </span>
        <Switch on={s.portrait} onChange={(on) => setLook({ portrait: on })} label="Portrait lighting" />
      </div>
      <div className={row}>
        <span className={`${lbl} inline-flex items-center gap-1.5`}>Auto-framing
          <Info text="Keeps you in the middle of the picture as you move. The camera doesn’t move — the picture is cut from it, never enlarged past twice" />
        </span>
        <Switch on={s.frame} onChange={(on) => setLook({ frame: on })} label="Auto-framing" />
      </div>
      <p className="pt-2 text-[12px] leading-relaxed text-ink-3">
        {!track ? "Turn the camera on to see it."
          : !stat ? "The camera goes out as it is."
          : stat.level === 0 ? "Paused to keep the call smooth — this device is busy. It comes back by itself."
          : stat.level === 1 ? "Running the light half only, to keep the call smooth."
          : (s.touch > 0 || s.light !== "off" || s.portrait || s.frame)
            ? <>Costs <span data-ay-skip="1">{stat.costMs < 0.05 ? "under 0.1" : stat.costMs.toFixed(1)}</span> ms a frame at <span data-ay-skip="1">{stat.fps}</span> fps
              {(s.portrait || s.frame) ? (stat.face ? " · face found" : " · looking for your face") : ""}
              {stat.exposure.dark && s.light === "auto" ? " · your room is dark, lifting it" : ""}</>
            : "Only you can see these until you switch one on."}
      </p>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors ${on ? "bg-yang" : "bg-veil/25"}`}>
      <span aria-hidden className={`absolute left-0 top-0.5 h-5 w-5 rounded-pill bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

function Slider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-2 pb-2 text-[12px] text-ink-3">
      <span>Low</span>
      <input type="range" min={0} max={100} value={Math.round(value * 100)} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-1.5 flex-1 cursor-pointer" style={{ accentColor: "var(--color-yang)" }} />
      <span>High</span>
    </div>
  );
}

function Info({ text }: { text: string }) {
  return (
    <span className="grid h-4 w-4 place-items-center rounded-pill border border-line text-[10px] leading-none text-ink-3" title={text} aria-label={text} role="img">i</span>
  );
}
