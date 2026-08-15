import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CATEGORIES, CATEGORY_GROUPS, SYSTEMS, PEDAGOGIES, statusLabel, selectionsToTags, selectionCount, selectionTags, hasSelection, totalTagCount, systemLearnUrl, emblemUrl, resolveImage,
  loadTypologies, typologiesReady,
} from "../lib/typologies";
import type { Selections, Selection, SpectrumLevel, TypologySystem, TypologyTag } from "../lib/typologies";
import { useCourseExists } from "../lib/useCourseExists";
import { getMyTypologies, saveMyTypologies, isLoggedIn, localePath } from "../lib/wp";
import { Avatar, Button, Card, DrillDownFilter, Input, LinkButton, Pill, PageHero, EmptyState, SearchPill, Select, SkeletonCard, cx, type FilterOption } from "../components/ui";
import { StatusBadge, DomainGlyph, AstroSignature } from "../components/catalogue";

const w = (typeof window !== "undefined" ? (window as unknown as Record<string, string>) : {}) || {};

// One pickable option (single = radio behaviour, multi = checkbox). The precise description sits
// right under the label — the page is a reference as much as a picker. Options that carry a
// profile picture (e.g. the fandom character groups, ticket #66) show it as a headshot beside
// the label; options without one keep the exact pre-#66 row.
function OptionRow({ multi, checked, label, short, desc, image, seed, onToggle }: {
  multi: boolean; checked: boolean; label: string; short?: string; desc: string; image?: string; seed: string; onToggle: () => void;
}) {
  return (
    <li>
      <button type="button" role={multi ? "checkbox" : "radio"} aria-checked={checked} onClick={onToggle}
        className={`flex w-full items-start gap-3 rounded-field border px-3.5 py-2.5 text-start transition-colors ${checked ? "border-yang/60 bg-yang/[0.06]" : "border-line hover:border-yin-light/40 hover:bg-veil/[0.02]"}`}>
        <span aria-hidden className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border ${multi ? "rounded-[4px]" : "rounded-full"} ${checked ? "border-yang bg-yang" : "border-ink-3"}`}>
          {checked && <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="var(--color-on-accent)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 6" /></svg>}
        </span>
        {/* Every group shows a profile picture: its authored image (a real canonical photo, or a
            self-hosted bespoke brand SVG resolved against the app base), else the deterministic
            brand emblem (never 404s) — never a bare row. */}
        <Avatar src={resolveImage(image) || emblemUrl(seed, label)} name={label} alt={label} className="h-11 w-11 shrink-0 text-sm ring-1 ring-line" />
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-ink">{label}{short && short !== label ? <span className="ms-2 text-[12px] font-normal text-ink-3">{short}</span> : null}</span>
          {desc && <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{desc}</span>}
        </span>
      </button>
    </li>
  );
}

const LEVELS: { key: SpectrumLevel; label: string }[] = [
  { key: "low", label: "Low" }, { key: "mid", label: "Balanced" }, { key: "high", label: "High" },
];

// One axis of a spectrum system (e.g. a Big Five trait) — a Low / Balanced / High segmented control
// flanked by the two pole labels, with the dimension's meaning underneath.
function SpectrumRow({ name, low, high, desc, value, onSet }: {
  name: string; low: string; high: string; desc: string; value?: SpectrumLevel; onSet: (l: SpectrumLevel) => void;
}) {
  return (
    <li className="rounded-field border border-line px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-semibold text-ink">{name}</span>
        <div role="radiogroup" aria-label={name} className="flex shrink-0 overflow-hidden rounded-pill border border-line">
          {LEVELS.map((l) => {
            const on = value === l.key;
            return (
              <button key={l.key} type="button" role="radio" aria-checked={on} onClick={() => onSet(l.key)}
                className={`px-3 py-1 text-[12px] font-semibold transition-colors ${on ? "bg-yang text-on-accent" : "text-ink-2 hover:bg-veil/5"}`}>
                {l.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-[12px] text-ink-3"><span>{low}</span><span>{high}</span></div>
      {desc && <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{desc}</p>}
    </li>
  );
}

function SystemCard({ sys, sel, onChange, openInitially }: {
  sys: TypologySystem; sel: Selection | undefined; onChange: (next: Selection | undefined) => void; openInitially: boolean;
}) {
  const [open, setOpen] = useState(openInitially);
  // Keep a search match (or a system you've selected) expanded even if this card was
  // already mounted before the query narrowed to it — `useState(openInitially)` only
  // applies on mount, so searching otherwise left the match collapsed (an extra click).
  useEffect(() => { setOpen(openInitially); }, [openInitially]);
  const count = selectionCount(sel);
  const picks = sel?.picks ?? [];
  const levels = sel?.levels ?? {};

  function setSelection(next: Selection) {
    const empty = !hasSelection(next);
    onChange(empty ? undefined : next);
  }
  function togglePick(key: string) {
    if (sys.format === "single") {
      const isOn = picks[0] === key;
      setSelection({ ...sel, picks: isOn ? [] : [key] });
    } else {
      const has = picks.includes(key);
      setSelection({ ...sel, picks: has ? picks.filter((k) => k !== key) : [...picks, key] });
    }
  }
  function setLevel(dimKey: string, lvl: SpectrumLevel) {
    const next = { ...levels };
    if (next[dimKey] === lvl) delete next[dimKey];
    else next[dimKey] = lvl;
    setSelection({ ...sel, levels: next });
  }

  // A one-line summary of the member's current pick(s), shown on the collapsed header.
  const summary = sel ? selectionTags(sys, sel).map((t) => t.short).slice(0, 4).join(" · ") : "";
  const more = count > 4 ? ` +${count - 4}` : "";

  // Only offer "Take the course" once a real course exists at the topic's (aspirational) course URL,
  // else fall back to the instructor video / search (ticket #132). Checked only while expanded.
  const courseExists = useCourseExists(open ? sys.course : undefined);
  const learn = courseExists ? sys : { ...sys, course: undefined };

  return (
    <Card className="overflow-hidden p-0 transition-colors hover:border-yin-light/40">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-start">
        {/* The topic's profile picture when one is set (real canonical image or self-hosted bespoke
            brand SVG, resolved against the app base), else the deterministic brand emblem — so every
            topic card reads as its own identity (ticket #67). */}
        <Avatar src={resolveImage(sys.image) || emblemUrl(sys.key, sys.name)} name={sys.name} alt={sys.name} className="h-11 w-11 shrink-0 text-sm ring-1 ring-line" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-bold text-ink">{sys.name}</span>
            <StatusBadge label={statusLabel(sys.status)} empirical={sys.status === "empirical"} />
            {count > 0 && <Pill className="px-2 py-0.5">{count} selected</Pill>}
          </span>
          {!open && summary && <span className="mt-1 block truncate text-[13px] text-yang-dark">{summary}{more}</span>}
          {!open && !summary && <span className="mt-1 block truncate text-[13px] text-ink-3">{sys.blurb}</span>}
        </span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`mt-1 shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-4">
          <p className="text-[14px] leading-relaxed text-ink-2">{sys.blurb}</p>
          <AstroSignature house={sys.house} sign={sys.sign} variant="inline" className="mt-2" />
          <p className="mt-1.5 text-[12px] leading-snug text-ink-3"><span className="font-semibold">{statusLabel(sys.status)}.</span> {sys.statusNote} <span className="text-ink-3/80">· {sys.source}</span></p>
          {/* Every system has an instructor to learn from — a curated explainer when we have one,
              otherwise a YouTube search that surfaces them. (Working toward a full course per system.) */}
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={systemLearnUrl(learn)} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-pill border border-yin/40 bg-yin/[0.06] px-3 py-1.5 text-[13px] font-semibold text-yin-light transition-colors hover:border-yang hover:text-yang">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
              {learn.course ? "Take the course" : learn.instructor ? `Watch ${learn.instructor} explain this` : "Learn this — watch an instructor"}
            </a>
            {/* Each topic has its own shareable landing page (a focused view + its own SEO URL). */}
            <a href={localePath(`/typologies/${sys.key}/`)}
              className="inline-flex items-center gap-1.5 rounded-pill border border-line px-3 py-1.5 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yin-light/40 hover:text-ink">
              Open full page
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 17 17 7M9 7h8v8" /></svg>
            </a>
          </div>

          {/* References — the real, verifiable papers behind the framework (ArtaPolish loop, never
              invented). Shown for research-backed / traditional systems; a DOI links over a URL. */}
          {sys.citations && sys.citations.length > 0 && (
            <div className="mt-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">References</p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {sys.citations.map((c, i) => {
                  const href = c.doi ? `https://doi.org/${c.doi}` : c.url;
                  const text = <>{c.authors} ({c.year}). {c.title}{c.venue ? <span className="italic">. {c.venue}</span> : null}</>;
                  return (
                    <li key={i} className="text-[12px] leading-snug text-ink-3">
                      {href
                        ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-yin-light transition-colors hover:text-yang">{text}</a>
                        : <span>{text}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {sys.format === "spectrum" ? (
            <ul className="mt-4 flex flex-col gap-2.5">
              {sys.dimensions?.map((d) => (
                <SpectrumRow key={d.key} name={d.name} low={d.low} high={d.high} desc={d.desc} value={levels[d.key]} onSet={(l) => setLevel(d.key, l)} />
              ))}
            </ul>
          ) : (
            <>
              <p className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                {sys.format === "multi" ? "Select all that apply" : "Select one"}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {sys.options?.map((o) => (
                  <OptionRow key={o.key} multi={sys.format === "multi"} checked={picks.includes(o.key)}
                    label={o.label} short={o.short} desc={o.desc} image={o.image} seed={o.key} onToggle={() => togglePick(o.key)} />
                ))}
              </ul>
            </>
          )}

          {sys.selfDescribe && (
            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink-2">Prefer to self-describe</span>
              <Input value={sel?.self ?? ""} maxLength={120} placeholder="In your own words…" className="bg-space-1 px-3.5"
                onChange={(e) => setSelection({ ...sel, self: e.target.value })} />
            </label>
          )}
        </div>
      )}
    </Card>
  );
}

// A live chip of one chosen tag, with an × to remove it.
function TagChip({ tag, onRemove }: { tag: TypologyTag; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-yang/40 bg-yang/[0.08] py-1 ps-3 pe-1.5 text-[13px] text-ink">
      <span className="text-ink-3">{tag.system}:</span><span className="font-semibold text-yang-dark">{tag.short}</span>
      <button type="button" aria-label={`Remove ${tag.short}`} onClick={onRemove}
        className="grid h-5 w-5 place-items-center rounded-full text-ink-3 transition-colors hover:bg-veil/10 hover:text-ink">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </span>
  );
}

export default function Topics({ embedded = false }: { embedded?: boolean } = {}) {
  const loggedIn = isLoggedIn();
  const [sp, setSp] = useSearchParams();
  const [sel, setSel] = useState<Selections>({});
  const [base, setBase] = useState<Selections>({});      // last saved baseline (for the dirty check)
  const [house, setHouse] = useState("");                 // selected top-level house ("" = all)
  const [subcat, setSubcat] = useState("");               // selected category within the house ("" = whole house)
  const [how, setHow] = useState(sp.get("how") || "");    // style (How) filter (seeded from ?how=)
  const [q, setQ] = useState(sp.get("q") || "");          // seeded from ?q= so Explore's topic links prefilter
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [allowance, setAllowance] = useState(0);          // groups this member may tag = lifetime points (1-to-1)
  const [points, setPoints] = useState(0);                // current standing, for the "earn more" hint
  const [dataReady, setDataReady] = useState(typologiesReady());
  const loaded = useRef(false);

  // Load the descriptive dataset (separate JSON asset; see lib/typologies.ts loadTypologies).
  useEffect(() => {
    if (dataReady) return;
    let on = true;
    loadTypologies().then(() => { if (on) setDataReady(true); });
    return () => { on = false; };
  }, [dataReady]);

  useEffect(() => {
    if (!loggedIn) return;
    getMyTypologies().then((d) => {
      setSel(d.selections); setBase(d.selections);
      setAllowance(d.allowance); setPoints(d.points);
      loaded.current = true;
    });
  }, [loggedIn]);

  function onQuery(v: string) {
    setQ(v);
    const next = new URLSearchParams(sp);
    if (v) next.set("q", v); else next.delete("q");
    setSp(next, { replace: true });
  }
  // How (style) facet — kept in the URL so links can deep-link into a filtered hub.
  function setHowFacet(v: string) {
    setHow(v);
    const next = new URLSearchParams(sp);
    if (v) next.set("how", v); else next.delete("how");
    setSp(next, { replace: true });
  }
  function clearFacets() {
    setHow("");
    const next = new URLSearchParams(sp); next.delete("how");
    setSp(next, { replace: true });
  }

  const dirty = useMemo(() => JSON.stringify(sel) !== JSON.stringify(base), [sel, base]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `dataReady` is an intentional recompute trigger: the typology dataset (SYSTEMS) is mutated in place when it loads async, so it isn't a reactive dep on its own.
  const tags = useMemo(() => selectionsToTags(sel), [sel, dataReady]);
  const total = totalTagCount(sel);
  // Effort-modulated tagging: a member may stand with as many groups as they have lifetime points.
  const over = loggedIn && total > allowance;                 // legacy/edge: already past the cap → must trim to save
  const remaining = Math.max(0, allowance - total);

  // The two-level facet tree for the drill-down filter: each house (top level) carries its system
  // count and the categories (subtopics) that actually have ≥1 system, so an empty branch of the
  // taxonomy never renders a dead chip. The category→house map turns a system's category into its
  // house for both counting and filtering. (Recomputes when the async dataset arrives.)
  const catGroup = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c.key, c.group] as const)), []);
  const filterOptions = useMemo<FilterOption[]>(() => {
    const houseN: Record<string, number> = {}, catN: Record<string, number> = {};
    for (const s of SYSTEMS) {
      catN[s.category] = (catN[s.category] ?? 0) + 1;
      const h = catGroup[s.category];
      if (h) houseN[h] = (houseN[h] ?? 0) + 1;
    }
    return CATEGORY_GROUPS.filter((g) => houseN[g.key]).map((g) => ({
      key: g.key, label: g.label, count: houseN[g.key],
      children: CATEGORIES.filter((c) => c.group === g.key && catN[c.key]).map((c) => ({ key: c.key, label: c.label, count: catN[c.key] })),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when the async dataset (SYSTEMS) arrives; `dataReady` is the load signal.
  }, [catGroup, dataReady]);

  const query = q.trim().toLowerCase();
  const systems = useMemo(() => SYSTEMS.filter((s) => {
    // Drill-down scope: a chosen category narrows to it; otherwise a chosen house narrows to every
    // system in that house; no selection = all. Search then composes on top of the current scope.
    if (subcat) { if (s.category !== subcat) return false; }
    else if (house) { if (catGroup[s.category] !== house) return false; }
    if (how && s.sign !== how) return false;     // style (How) facet → sign column
    if (!query) return true;
    // Match the system KEY too, so a deep-link like /typologies/?q=big-five (the URL the SEO DefinedTerm
    // points at) surfaces + expands that topic instead of landing on an empty search.
    if (s.key.includes(query) || s.name.toLowerCase().includes(query) || s.blurb.toLowerCase().includes(query)) return true;
    return (s.options ?? []).some((o) => o.label.toLowerCase().includes(query) || o.desc.toLowerCase().includes(query))
      || (s.dimensions ?? []).some((d) => d.name.toLowerCase().includes(query));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when the async dataset (SYSTEMS) arrives; `dataReady` is the load signal.
  }), [house, subcat, how, catGroup, query, dataReady]);

  function updateSystem(key: string, next: Selection | undefined) {
    const copy = { ...sel };
    if (next) copy[key] = next; else delete copy[key];
    // Block additions that would exceed the member's effort-based allowance (removals always allowed,
    // even from an over-cap legacy state). Gating is client-side; the server enforces the same cap.
    if (loggedIn) {
      const nextCount = totalTagCount(copy);
      if (nextCount > total && nextCount > allowance) {
        const short = nextCount - allowance;
        setMsg(`You can stand with ${allowance} group${allowance === 1 ? "" : "s"} at your standing — earn ${short} more point${short === 1 ? "" : "s"}, or remove one first`);
        return;
      }
    }
    setSel(copy);
    setMsg("");
  }

  function removeTag(t: TypologyTag) {
    setSel((prev) => {
      const s = prev[t.systemKey];
      if (!s) return prev;
      const next: Selection = { ...s };
      if (t.key === "self") next.self = "";
      else if (t.key.includes(":") && next.levels) { const dk = t.key.split(":")[0]; const lv = { ...next.levels }; delete lv[dk]; next.levels = lv; }
      else if (next.picks) next.picks = next.picks.filter((k) => k !== t.key);
      const copy = { ...prev };
      if (hasSelection(next)) copy[t.systemKey] = next; else delete copy[t.systemKey];
      return copy;
    });
    setMsg("");
  }

  async function save() {
    if (!loggedIn) { window.location.href = localePath(w.AQ_LOGIN_URL || "/login/"); return; }
    if (saving) return;
    setSaving(true); setMsg("");
    try {
      const r = await saveMyTypologies(sel, tags);
      if (!r.ok) {
        if (typeof r.allowance === "number") setAllowance(r.allowance);
        setMsg(r.message || "Could not save — please try again");
        return;
      }
      setBase(sel);
      if (typeof r.allowance === "number") setAllowance(r.allowance);
      setMsg(`Saved — ${r.count} public tag${r.count === 1 ? "" : "s"} on your profile`);
    } catch {
      setMsg("Could not save — please try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cx("flex flex-col gap-6", !embedded && "pb-28")}>
      {!embedded && (
        <PageHero
          eyebrow="Find yourself" glyph={<DomainGlyph domain="topic" />}
          title="Typologies"
          lede="Every framework people use to make sense of who they are — personality models, temperaments, the popular typologies and traditions, and the identities and communities you belong to. Each option is described plainly and honestly, with no claim that a system is more than it is."
        />
      )}
      <p className="max-w-3xl rounded-card border border-yin/30 bg-yin/[0.06] px-4 py-3 text-[13.5px] leading-relaxed text-ink-2">
        <span className="font-semibold text-ink">Everything you select is public.</span> Choosing a group is a statement
        you make to the world — and publicly identifying with a group is how you can stand with its donation class. Add or
        remove a tag at any time; nothing is shown until you choose it.
      </p>

      {/* Effort-modulated tagging: 1 group per lifetime point. Shows used / available slots + how to earn more. */}
      {loggedIn && (
        <div className={`max-w-3xl rounded-card border px-4 py-3 text-[13.5px] leading-relaxed ${over ? "border-rose-400/40 bg-rose-500/[0.08] text-ink-2" : "border-yang/30 bg-yang/[0.06] text-ink-2"}`}>
          <span className="font-semibold text-ink">{Math.min(total, allowance)} of {allowance} group{allowance === 1 ? "" : "s"}</span> used.{" "}
          {over
            ? <>You're standing with more groups than your effort allows — remove <b className="text-ink">{total - allowance}</b> to save your changes.</>
            : remaining > 0
              ? <>You can add <b className="text-ink">{remaining}</b> more.</>
              : <>You've used every slot — <b className="text-ink">earn 1 more point</b> to unlock another group.</>}
          {" "}Every point of standing earns you one more group — points come from learning, discussing, donating, and contributing. <span className="text-ink-3">You have {points} point{points === 1 ? "" : "s"}.</span>
        </div>
      )}

      {/* Live summary of the member's chosen public tags. */}
      {total > 0 && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-bold tracking-tight">Your public tags <span className="font-normal text-ink-3">({loggedIn ? `${total} / ${allowance}` : total})</span></h2>
            <LinkButton onClick={() => setSel({})} className="text-[12px] font-semibold hover:text-rose-300">Clear all</LinkButton>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => <TagChip key={`${t.systemKey}:${t.key}`} tag={t} onRemove={() => removeTag(t)} />)}
          </div>
        </Card>
      )}

      {/* Search + a two-level drill-down filter: pick a house (top-level chips, each with its system
          count), then that house's subtopics reveal beneath — instead of the old wall of every category
          at once. Only houses/categories that actually have systems show, so the taxonomy can carry
          not-yet-populated branches harmlessly. Search sits on top so it's the first thing reached, and
          composes with the chosen scope. */}
      <div className="flex flex-col gap-3">
        <SearchPill value={q} onChange={onQuery} placeholder="Search systems and options — “INTJ”, “temperament”, “bisexual”, “Hindi”…" />
        <DrillDownFilter
          ariaLabel="Filter topics by area"
          options={filterOptions}
          group={house} sub={subcat}
          onSelect={(g, s) => { setHouse(g); setSubcat(s); }}
          allLabel={dataReady ? `All ${SYSTEMS.length} systems` : "All systems"}
        />
        {/* Browse by HOW (the approach it's presented in) — the curriculum lens every topic carries
            alongside its field. Deep-linkable. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Browse by</span>
          <Select label="Filter by approach (How)" value={how} onChange={setHowFacet}
            options={[{ value: "", label: "Any approach" }, ...PEDAGOGIES.map((p) => ({ value: p.key, label: `How · ${p.label}` }))]} className="h-10 text-[13px]" />
          {how && <Button variant="ghost" size="sm" onClick={clearFacets}>Clear</Button>}
        </div>
      </div>

      {subcat && (() => {
        const c = CATEGORIES.find((x) => x.key === subcat);
        return c ? <p className="-mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-3">{c.blurb}</p> : null;
      })()}

      {/* The systems. */}
      <div className="flex flex-col gap-3">
        {!dataReady && Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} media={false} />)}
        {dataReady && systems.length === 0 && (
          <EmptyState icon={<DomainGlyph domain="topic" className="h-6 w-6" />} title={`No systems match “${q}”`}
            body="Try another framework, type, or identity — or clear the search to browse them all." />
        )}
        {systems.map((s) => (
          <SystemCard key={s.key} sys={s} sel={sel[s.key]} openInitially={Boolean(query) || hasSelection(sel[s.key])}
            onChange={(next) => updateSystem(s.key, next)} />
        ))}
      </div>

      {/* Save bar. Standalone → fixed to the viewport; EMBEDDED as a Library tab → a `sticky bottom-0`
          bar that lives in the tab's own flow (never a fixed overlay floating across the whole app),
          so the Typologies tab reads consistently with every other Library tab (operator 2026-07-06). */}
      <div className={cx(
        "z-30 border-t border-line bg-space-1/95 backdrop-blur supports-[backdrop-filter]:bg-space-1/80",
        embedded ? "sticky bottom-0 -mx-4" : "fixed inset-x-0 bottom-0",
      )}>
        <div className={cx("flex items-center justify-between gap-4 py-3", embedded ? "px-4" : "mx-auto max-w-content px-4 sm:px-6")}>
          <p className="min-w-0 text-[13px] text-ink-2">
            {total > 0 ? <><b className="text-ink">{total}</b> public tag{total === 1 ? "" : "s"} chosen{loggedIn && <> of <b className="text-ink">{allowance}</b></>}</> : "Nothing selected yet"}
            {msg && <span className={`ms-3 ${/Saved/.test(msg) ? "text-yang" : "text-rose-300"}`} role="status">{msg}</span>}
          </p>
          {loggedIn ? (
            <Button onClick={save} disabled={!dirty || saving || over} className="h-10 shrink-0 px-6 text-[14px] disabled:opacity-40">
              {saving ? "Saving…" : over ? "Over limit" : dirty ? "Save to profile" : "Saved"}
            </Button>
          ) : (
            <Button href={w.AQ_LOGIN_URL || "/login/"} className="h-10 shrink-0 px-6 text-[14px]">Sign in to save</Button>
          )}
        </div>
      </div>
    </div>
  );
}
