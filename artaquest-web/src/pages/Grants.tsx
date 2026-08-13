import { useEffect, useMemo, useState, Fragment, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getOutreach, claimGrant, submitGrant, releaseGrant, isLoggedIn, localePath,
  type OutreachGrant, type OutreachData, type OutreachMember,
} from "../lib/wp";
import { Points } from "../lib/currency";
import { Button, Card, Pill, Textarea, Input, Avatar, Chip, LinkButton, SearchPill, PageHero, Toolbar, EmptyState, ErrorNote, StatusNote, cx } from "../components/ui";
import { DomainGlyph, fmtDate, daysUntil } from "../components/catalogue";

function fmtMeeting(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Relative urgency for a deadline ("today", "in 12 days", "passed") from a whole-day count.
// `null` (no fixed date) reads as "Rolling" at the call site, so it's handled there.
function relDeadline(days: number): string {
  if (days < 0) return "passed";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// CA✗/Intl✓ → readable eligibility chips.
function eligChips(g: OutreachGrant) {
  const out: { label: string; tone: "ok" | "warn" | "muted" }[] = [];
  const ca = g.eligibility_ca;
  if (ca === "yes") out.push({ label: "CA charity", tone: "ok" });
  else if (ca === "via_equivalency_or_sponsor") out.push({ label: "CA via equiv.", tone: "warn" });
  else if (ca === "no") out.push({ label: "Not CA", tone: "muted" });
  if (g.eligibility_intl === "yes") out.push({ label: "International", tone: "ok" });
  return out;
}

// Stacked avatars of the members registered on a grant; links into each profile.
function Registrants({ members, max = 4 }: { members: OutreachMember[]; max?: number }) {
  if (!members.length) return <span className="text-[12.5px] text-ink-3">—</span>;
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {shown.map((m) => (
          <a key={m.slug} href={localePath(`/u/${m.slug}/`)} title={`${m.name}${m.status === "verified" ? " · verified" : m.status === "submitted" ? " · submitted" : ""}`}
             className="relative rounded-full ring-2 ring-space-2 transition hover:z-10 hover:ring-yang">
            <Avatar src={m.avatar} name={m.name} country={m.country} className="h-7 w-7" />
          </a>
        ))}
      </div>
      {extra > 0 && <span className="ms-2 text-[12px] tabular-nums text-ink-3">+{extra}</span>}
    </div>
  );
}

// The expandable detail panel for one grant: summary, red flags, full registrant list,
// scheduled sessions, and the member's claim/submit/release controls.
function GrantDetail({ g, loggedIn, onChanged }: { g: OutreachGrant; loggedIn: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [note, setNote] = useState("");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");

  async function run(p: Promise<{ ok: boolean; error?: string }>) {
    setBusy(true); setErr("");
    const r = await p;
    setBusy(false);
    if (!r.ok) { setErr(r.error || "Something went wrong — try again."); return; }
    onChanged();
  }

  const full = g.slots_left <= 0;

  return (
    <div className="grid gap-5 border-t border-line/70 bg-space-1/40 p-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-3">
        {g.summary && <p className="text-[13px] leading-relaxed text-ink-2">{g.summary}</p>}
        {g.red_flags && <p className="text-[12.5px] leading-relaxed text-rose-300/80"><strong className="text-rose-300">Watch-outs:</strong> {g.red_flags}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          {g.url && <a href={g.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-yang">Funder page ↗</a>}
          {g.gcal_url && <a href={g.gcal_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-yang">＋ Add deadline to Google Calendar</a>}
          {g.confidence && <span>Confidence: {g.confidence}</span>}
          {g.author && (
            <span>Curated by <a href={localePath(`/u/${g.author.slug}/`)} className="text-ink-2 hover:text-yang hover:underline">{g.author.name}</a></span>
          )}
        </div>

        {/* who is registered */}
        <div>
          <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Registered ({g.members.length})</h4>
          {g.members.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">No one yet — be the first to help apply.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {g.members.map((m) => (
                <li key={m.slug} className="flex items-center gap-2 text-[13px]">
                  <a href={localePath(`/u/${m.slug}/`)} className="flex items-center gap-2 hover:text-yang">
                    <Avatar src={m.avatar} name={m.name} country={m.country} className="h-6 w-6" />
                    <span>{m.name}</span>
                  </a>
                  <span className={cx("rounded-full px-1.5 py-0.5 text-[11px]",
                    m.status === "verified" ? "bg-yang/15 text-yang" : m.status === "submitted" ? "bg-yin/15 text-yin-light" : "bg-veil/5 text-ink-2")}>{m.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* scheduled working sessions — ArtaMeet, on ArtaQuest, end-to-end encrypted */}
        {g.meetings.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Working sessions (1 hr · Meet)</h4>
            <ul className="flex flex-col gap-1.5">
              {g.meetings.map((mt) => (
                <li key={mt.reminder_key} className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                  <span className="tabular-nums" data-ay-skip="1">{fmtMeeting(mt.start)}</span>
                  {mt.meet_url ? (
                    <>
                      <Link to={localePath(mt.meet_url)} className="rounded-md bg-yin/15 px-2 py-0.5 text-[12px] font-medium text-yin-light no-underline hover:bg-yin/25">Open the session</Link>
                      <span className="text-[12px] text-ink-3">opens 15 minutes before</span>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-3">Registrants get a join link</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12px] text-ink-3">Held here on ArtaQuest, end-to-end encrypted, up to five people to a session</p>
          </div>
        )}
        {g.meetings.length === 0 && g.deadline && (
          <p className="text-[12px] text-ink-3">No working sessions yet — one is scheduled 14 days and again 1 day before the deadline, for everyone registered by then</p>
        )}
      </div>

      {/* action column */}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-space-2 p-3.5">
        <div className="flex items-center justify-between text-[12.5px] text-ink-3">
          <span><strong className="text-ink-2"><Points n={g.points} /></strong> points</span>
          <span><strong className="text-ink-2 tabular-nums">{g.slots_left}</strong>/{g.capacity} slots</span>
        </div>
        {!loggedIn ? (
          <a href={localePath("/login/")} className="text-[13px] font-medium text-yang hover:underline">Sign in to claim this sponsor →</a>
        ) : g.my_status === "verified" ? (
          <Pill className="bg-yang/15 text-yang">✓ Verified — {g.points.toLocaleString()} points awarded</Pill>
        ) : g.my_status === "submitted" ? (
          <div className="flex flex-col gap-2">
            <Pill className="bg-yang/12 text-yang">Submitted — pending review</Pill>
            <LinkButton disabled={busy} onClick={() => run(releaseGrant(g.id))} className="self-start text-[12.5px]">Withdraw</LinkButton>
          </div>
        ) : g.my_status === "claimed" ? (
          !showSubmit ? (
            <div className="flex flex-col gap-2">
              <Pill className="bg-yin/12 text-yin-light">You claimed this — prepare the application</Pill>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => setShowSubmit(true)}>Mark submitted</Button>
                <LinkButton disabled={busy} onClick={() => run(releaseGrant(g.id))} className="text-[12.5px]">Release</LinkButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-ink-3">Hand your draft to the foundation, then record it here. Points credit after it's verified.</p>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Link to your draft (optional)" />
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notes for the foundation (optional)" rows={2} />
              <div className="flex items-center gap-3">
                <Button size="sm" disabled={busy} onClick={() => run(submitGrant(g.id, note, ref))}>{busy ? "Saving…" : "Submit for review"}</Button>
                <LinkButton onClick={() => setShowSubmit(false)} className="text-[12.5px]">Cancel</LinkButton>
              </div>
            </div>
          )
        ) : full ? (
          <Pill className="bg-veil/5 text-ink-3">All {g.capacity} slots claimed</Pill>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => run(claimGrant(g.id))}>{busy ? "Claiming…" : "Claim & apply on our behalf"}</Button>
        )}
        {err && <p role="alert" className="text-[12.5px] text-rose-400">{err}</p>}
      </div>
    </div>
  );
}

type SortKey = "deadline" | "amount_cad" | "fit" | "slots_left" | "taken";
const FITS = [0, 3, 4, 5] as const;

export default function Grants() {
  const [sp, setSp] = useSearchParams();
  const [data, setData] = useState<OutreachData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState(sp.get("q") || "");   // seeded from ?q= so Explore's grant links prefilter
  const [elig, setElig] = useState<"all" | "ca" | "intl">("all");
  const [kind, setKind] = useState<"all" | "sponsor" | "charity">("all");   // industry partner vs charitable grant
  const [minFit, setMinFit] = useState(0);
  const [mineOnly, setMineOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "deadline", dir: 1 });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const loggedIn = isLoggedIn();

  const load = () => getOutreach().then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true));
  useEffect(() => { load(); }, []);

  function onQuery(v: string) {
    setQuery(v);
    const next = new URLSearchParams(sp);
    if (v) next.set("q", v); else next.delete("q");
    setSp(next, { replace: true });
  }
  function toggle(id: number) {
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function setSortKey(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "deadline" ? 1 : -1 }));
  }

  const rows = useMemo(() => {
    let list = (data?.grants || []).slice();
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((g) => (g.title + " " + g.funder + " " + g.country).toLowerCase().includes(q));
    if (elig === "ca") list = list.filter((g) => g.eligibility_ca === "yes" || g.eligibility_ca === "via_equivalency_or_sponsor");
    if (elig === "intl") list = list.filter((g) => g.eligibility_intl === "yes");
    if (kind === "sponsor") list = list.filter((g) => g.is_sponsor);
    if (kind === "charity") list = list.filter((g) => !g.is_sponsor);
    if (minFit) list = list.filter((g) => g.fit >= minFit);
    if (mineOnly) list = list.filter((g) => g.my_status);
    const { key, dir } = sort;
    list.sort((a, b) => {
      if (key === "deadline") {
        const av = a.deadline || "9999-99-99", bv = b.deadline || "9999-99-99";
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      return (a[key] - b[key]) * dir;
    });
    return list;
  }, [data, query, elig, kind, minFit, mineOnly, sort]);

  const datedCount = (data?.grants || []).filter((g) => g.deadline).length;
  const Th = ({ k, children, className }: { k?: SortKey; children: ReactNode; className?: string }) => (
    <th className={cx("px-3 py-2 text-left font-semibold", className)}>
      {k ? (
        /* -my-1 py-1: these were 18px-tall targets, and sorting is the main thing anyone does to a
           table of 166 funders. The negative margin absorbs the padding so the header row does not
           grow. type=button because a bare <button> defaults to submit, which is a live hazard the
           day this table lands inside a form. The glyph goes to 11px, the platform's meta size —
           10px was the smallest type on the page and it is a control, not a footnote. */
        <button type="button" onClick={() => setSortKey(k)} className="-my-1 inline-flex items-center gap-1 py-1 hover:text-ink">
          {children}<span className="text-[11px] text-ink-2">{sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</span>
        </button>
      ) : children}
    </th>
  );

  return (
    <div className="flex flex-col gap-6 pb-12">
      <PageHero
        eyebrow="Win funding" glyph={<DomainGlyph domain="grant" />}
        title="Sponsors"
        lede={<>ArtaQuest is funded by sponsors. We research funding programmes and industry partners worldwide — for the open-education platform, for paying creators to produce learning content, and for learner bursaries — and post every deadline here. <strong className="text-ink">Claim a sponsor to help us apply</strong>, and earn <strong className="text-ink">points equal to the sponsorship amount</strong> in the <a href={localePath("/rankings/")} className="text-yang hover:underline">rankings</a>. Registered members are invited to <strong className="text-ink">working sessions on Meet</strong> before each deadline.</>}
      />

      <div className="grid gap-3 rounded-card border border-line bg-space-2 p-4 text-[13.5px] leading-relaxed text-ink-2 sm:grid-cols-3">
        <p><strong className="text-ink">1. Claim</strong> — pick a sponsor (first-come, limited slots). You commit to help draft the application on the foundation's behalf, and join the group working sessions.</p>
        <p><strong className="text-ink">2. Submit</strong> — prepare the application and hand your draft to the foundation. Nothing is sent to a funder without the foundation's review and approval.</p>
        <p><strong className="text-ink">3. Earn</strong> — once the foundation verifies the application was submitted, you're credited points equal to the sponsor's value.</p>
      </div>

      <Toolbar
        sticky
        search={<SearchPill placeholder="Search sponsors, funders, countries…" value={query} onChange={onQuery} className="min-w-[220px] flex-1" />}
        filters={<>
          <Chip active={elig === "all"} onClick={() => setElig("all")}>All</Chip>
          <Chip active={elig === "ca"} onClick={() => setElig("ca")}>CA-eligible</Chip>
          <Chip active={elig === "intl"} onClick={() => setElig("intl")}>International</Chip>
          <span className="mx-0.5 h-4 w-px self-center bg-line" aria-hidden />
          <Chip active={kind === "all"} onClick={() => setKind("all")}>Any kind</Chip>
          <Chip active={kind === "charity"} onClick={() => setKind("charity")}>Charitable</Chip>
          <Chip active={kind === "sponsor"} onClick={() => setKind("sponsor")} className={kind === "sponsor" ? undefined : "text-yang"}>Industry partner</Chip>
          <span className="mx-0.5 h-4 w-px self-center bg-line" aria-hidden />
          {FITS.map((f) => (
            <Chip key={f} active={minFit === f} onClick={() => setMinFit(f)}>{f === 0 ? "Any fit" : `Fit ${f}+`}</Chip>
          ))}
          {loggedIn && <Chip active={mineOnly} onClick={() => setMineOnly((v) => !v)}>Mine</Chip>}
        </>}
        trailing={data?.ics_url ? <Button href={data.ics_url} variant="outline" size="sm">Subscribe (.ics)</Button> : undefined}
        count={data ? `${rows.length} of ${data.count} sponsors · ${datedCount} dated · ${data.total_registered} registrations` : "Loading…"}
      />

      {failed ? (
        <ErrorNote>Couldn’t load sponsors — refresh to try again.</ErrorNote>
      ) : !data ? (
        <StatusNote>Loading sponsors…</StatusNote>
      ) : rows.length === 0 ? (
        <EmptyState icon={<DomainGlyph domain="grant" className="h-6 w-6" />} title="No sponsors match your filters"
          body="Try widening a filter — show all kinds, lower the fit, or search a different funder, country or programme. New deadlines are added all the time, so check back soon." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line bg-space-1/60 text-[12px] uppercase tracking-wide text-ink-3">
                <Th>Sponsor</Th>
                <Th k="deadline">Deadline</Th>
                <Th k="amount_cad" className="text-right">Amount</Th>
                <Th>Eligibility</Th>
                <Th k="fit" className="text-center">Fit</Th>
                <Th k="slots_left" className="text-center">Slots</Th>
                <Th k="taken">Registered</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const isOpen = open.has(g.id);
                const du = daysUntil(g.deadline);
                const soon = du !== null && du >= 0 && du <= 30;
                return (
                  <Fragment key={g.id}>
                    <tr onClick={() => toggle(g.id)}
                        className={cx("cursor-pointer border-b border-line/60 align-top transition hover:bg-veil/[0.03]", isOpen && "bg-veil/[0.04]")}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <span className={cx("mt-1 text-[11px] text-ink-2 transition", isOpen && "rotate-90")}>▶</span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold leading-tight text-ink">{g.title}</span>
                              {g.is_sponsor && <span className="rounded-full bg-yang/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-yang" title="An industry partner, not a charitable grant">Industry partner</span>}
                            </div>
                            <div className="text-[12.5px] text-ink-3">{g.funder}{g.country ? ` · ${g.country}` : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        {g.deadline ? (
                          <span className={cx("font-medium tabular-nums", du !== null && du < 0 ? "text-ink-3 line-through decoration-ink-3/40" : soon ? "text-yang" : "text-ink-2")}>
                            <time dateTime={g.deadline}>{fmtDate(g.deadline)}</time>{g.estimated ? "≈" : ""}
                            {du !== null && <span className="ms-1 text-[11px] text-ink-2">({relDeadline(du)})</span>}
                          </span>
                        ) : <span className="text-ink-3">Rolling</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{g.amount_display || "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {eligChips(g).map((c) => (
                            <span key={c.label} className={cx("whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px]",
                              c.tone === "ok" ? "bg-yang/12 text-yang" : c.tone === "warn" ? "bg-yin/15 text-yin-light" : "bg-veil/5 text-ink-2")}>{c.label}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {g.fit >= 4 ? <span className="rounded-full bg-yang/15 px-1.5 py-0.5 text-[11px] font-medium text-yang">{g.fit}</span> : <span className="text-ink-2">{g.fit || "—"}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-ink-2">{g.slots_left}/{g.capacity}</td>
                      <td className="px-3 py-2.5"><Registrants members={g.members} /></td>
                      <td className="px-3 py-2.5 text-right">
                        {g.my_status === "verified" ? <span className="text-[12px] font-medium text-yang">✓ Verified</span>
                          : g.my_status === "submitted" ? <span className="text-[12px] text-yang">Submitted</span>
                          : g.my_status === "claimed" ? <span className="text-[12px] text-yin-light">Claimed</span>
                          : g.slots_left <= 0 ? <span className="text-[12px] text-ink-3">Full</span>
                          : <span className="text-[12px] font-medium text-yang">{isOpen ? "—" : "Claim →"}</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="p-0">
                          <GrantDetail g={g} loggedIn={loggedIn} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <p className="max-w-3xl text-[12px] leading-relaxed text-ink-3">
        Deadlines marked ≈ are estimated from prior cycles — always confirm on the funder's official page before applying.
        Eligibility reflects the ArtaQuest Foundation as a Canadian non-profit corporation WITHOUT charitable registration — several funders below require registered charity status, and some fund only the platform / content work rather than cash bursaries.
        Applications are reviewed by the foundation before any submission to a funder. Who has registered for each sponsor is public.
      </p>
    </div>
  );
}
