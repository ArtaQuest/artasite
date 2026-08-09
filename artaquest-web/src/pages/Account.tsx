import { useEffect, useMemo, useRef, useState } from "react";
import { DobWheel } from "../components/DobWheel";
import { checkUsername, getDashboard, getCourseCards, isLoggedIn, localePath, postProfileUpdate, PROFILE_LINKS, type CourseCard, type Dashboard, type UsernameCheck } from "../lib/wp";
import { Sessions, Funds, BURSARY_GROUPS, Account as AccountApi, ApiError, ApiTokens, KaggleIds, Passkeys, ShellAccount, UsageApi, myParticipation, setGender as setGender_, type PasskeyItem, type ApiTokenItem, type ApiTokenScope, type KaggleIdItem, type SessionItem, type ShellInfo, type ShellKey, type UsageInfo, type BursaryResult, type BursaryStatus, type ShareKit } from "../lib/api";
import { signOut } from "../lib/auth";
import { VerifyApi, fileToImage, type VerifyStatus } from "../lib/verify";
import { countryName, countryOptions, flagEmoji } from "../lib/flags";
import { BlueCheck } from "../components/BlueCheck";
import { Avatar, Button, Card, CertBadge, ErrorNote, Field, Input, Pill, SignInGate, StatusNote, Textarea } from "../components/ui";


function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-[24px] font-bold leading-none text-ink">{value}</div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink-2">{label}</div>
      {sub ? <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div> : null}
    </Card>
  );
}

// Inline profile editor — replaces the old /wp-admin/profile.php link (no WP UI).
function SettingsForm({ user, onSaved }: { user: Dashboard["user"]; onSaved: (name: string, bio: string, slug?: string) => void }) {
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio || "");
  // Held as its own state per network, so a member editing one field cannot disturb another and a
  // rejected value stays on screen to be corrected rather than being thrown away.
  const [links, setLinks] = useState<Record<string, string>>(() =>
    Object.fromEntries(PROFILE_LINKS.map(([k]) => [k, (user.links as Record<string, string> | undefined)?.[k] ?? ""])));
  const [username, setUsername] = useState(user.slug || "");
  const [check, setCheck] = useState<UsernameCheck | null>(null); // live availability of a NEW handle
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const usernameChanged = username !== (user.slug || "") && username !== "";
  const linksDirty = PROFILE_LINKS.some(([k]) => (links[k] || "") !== ((user.links as Record<string, string> | undefined)?.[k] ?? ""));
  const dirty = name.trim() !== user.name || bio !== (user.bio || "") || usernameChanged || linksDirty;

  // Debounced live availability check — only while the handle differs from the current one.
  useEffect(() => {
    if (!usernameChanged) { setCheck(null); return; }
    let stale = false;
    setCheck(null); // typing again invalidates the previous verdict
    const t = setTimeout(() => { checkUsername(username).then((r) => { if (!stale) setCheck(r); }); }, 400);
    return () => { stale = true; clearTimeout(t); };
  }, [username, usernameChanged]);

  async function save() {
    if (!name.trim() || saving) return;
    if (usernameChanged && check && !check.available) return; // known-bad handle — keep editing
    setSaving(true);
    setMsg("");
    try {
      const r = await postProfileUpdate(name.trim(), bio, usernameChanged ? username : undefined, links);
      if (!r.ok) { setMsg(r.message || "Could not save — try again"); return; }
      if (r.links) setLinks(Object.fromEntries(PROFILE_LINKS.map(([k]) => [k, (r.links as Record<string, string>)[k] ?? ""])));
      // Adopt what the server actually stored (a simultaneous claim can suffix the handle).
      if (r.slug) setUsername(r.slug);
      onSaved(r.name, r.bio, r.slug);
      setMsg("Saved");
    } catch {
      setMsg("Could not save — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card as="section" className="p-5">
      <h2 className="text-[18px] font-bold tracking-tight">Edit profile</h2>
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="bg-space-1 px-3.5" />
        </Field>
        <Field label="Username">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink-3" aria-hidden>@</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-space-1 px-3.5"
            />
          </div>
          <span className="text-[12px] font-normal text-ink-3">
            Your public profile lives at /u/{username || "…"}/ — you can change it at any time, but links to your old address will stop working.
          </span>
          {usernameChanged && check && (
            <span role="status" className={`text-[12px] font-normal ${check.available ? "text-yang" : "text-rose-300"}`}>
              {check.available ? `@${check.username} is available` : check.message || "That username is already taken."}
            </span>
          )}
        </Field>
        <Field label="Bio">
          <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} maxLength={600} placeholder="Tell the community what you are exploring." className="resize-y bg-space-1 px-3.5" />
          <span className="self-end text-[12px] font-normal text-ink-3">{bio.length}/600</span>
        </Field>
        {/* WHERE ELSE YOU ARE. Two fields per row on anything wider than a phone: seven stacked
            inputs reads as a form to endure, and none of them is required. A bare handle is enough —
            the server turns it into the real address and hands it back, which is why the value can
            change under the cursor after a save. */}
        <Field label="Where else you are">
          <span className="text-[12.5px] font-normal text-ink-3">
            Optional. Paste the address, or just your handle. These appear on your profile and tell search
            engines that this page and your other accounts are the same person.
          </span>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {PROFILE_LINKS.map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1">
                <span className="text-[12.5px] font-normal text-ink-3">{label}</span>
                <Input value={links[k] || ""} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(e) => setLinks((l) => ({ ...l, [k]: e.target.value }))}
                  placeholder={k === "website" || k === "mastodon" ? "https://…" : "your handle"}
                  className="bg-space-1 px-3.5" />
              </label>
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={!dirty || !name.trim() || saving || (usernameChanged && !!check && !check.available)} className="h-10 px-6 text-[14px] disabled:opacity-40">
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {msg && <span role="status" className={`text-[13px] ${msg === "Saved" ? "text-yang" : "text-rose-300"}`}>{msg}</span>}
        </div>
      </div>
    </Card>
  );
}

// ── Security · active sign-in sessions ──────────────────────────────────────
// Surfaces the WordPress-recorded sessions (IP→location, device, time) so a member can SEE every
// place their account is signed in and sign out anything suspicious. Because the whole DB is public,
// being able to spot + kill a rogue session is the user's front-line defence against impersonation.
function deviceIcon(type: string) {
  return type === "mobile" ? "📱" : type === "tablet" ? "📓" : "🖥️";
}
function ago(ts: number) {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function SessionManager() {
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState<string>(""); // id (or "others") currently being revoked

  const load = () => {
    Sessions.list()
      .then((r) => { setItems(r.items); setErr(false); })
      .catch(() => setErr(true));
  };
  useEffect(load, []);

  async function revokeOne(s: SessionItem) {
    setBusy(s.id);
    try {
      if (s.current) {
        // Signing out THIS device → the shared immediate sign-out (API logout + straight home —
        // never the WP logout URL, whose nonce would fail and show a confirmation page, #42).
        await signOut();
        return;
      }
      await Sessions.revoke(s.id);
      setItems((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
    } catch { setErr(true); } finally { setBusy(""); }
  }
  async function revokeOthers() {
    setBusy("others");
    try {
      await Sessions.revokeOthers();
      setItems((prev) => (prev ? prev.filter((x) => x.current) : prev));
    } catch { setErr(true); } finally { setBusy(""); }
  }

  const others = items?.filter((x) => !x.current).length ?? 0;

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Security · where you're signed in</h2>
        {others > 0 && (
          <Button variant="outline" onClick={revokeOthers} disabled={busy === "others"} className="h-9 px-3 text-[13px] hover:text-rose-300">
            {busy === "others" ? "Signing out…" : `Sign out all other devices (${others})`}
          </Button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-3">
        Each active sign-in is listed below with its approximate location, device, and time. See something you don't recognise? Sign it out — and request a fresh code next time you sign in.
      </p>

      {err && <ErrorNote className="mt-4">We couldn't load your sessions. Please reload the page.</ErrorNote>}
      {!items && !err && <StatusNote className="py-4 text-start">Loading sessions…</StatusNote>}

      {items && items.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="text-[22px] leading-none" aria-hidden>{deviceIcon(s.device.type)}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-semibold">{s.device.label}</span>
                      {s.current && <Pill className="px-2 py-0.5 text-[11px] text-yang">This device</Pill>}
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-3">
                      <span aria-hidden>{s.location.flag}</span> {s.location.label}
                      {s.ip && <span className="text-ink-3/70"> · {s.ip}</span>}
                      {s.login ? <span> · signed in {ago(s.login)}</span> : null}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => revokeOne(s)}
                  disabled={busy === s.id}
                  className="h-9 px-3 text-[13px] hover:text-rose-300"
                >
                  {busy === s.id ? "Signing out…" : "Sign out"}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {items && items.length === 0 && !err && (
        <p className="mt-4 text-[14px] text-ink-3">No other active sessions.</p>
      )}
    </section>
  );
}

// ── Developer API tokens ────────────────────────────────────────────────────
// Personal access tokens for scripts + AI agents (docs at /developers). The raw token is shown
// exactly once, in the create response; the server keeps only a hash. Management is deliberately
// session-only — a token can never mint or revoke tokens — and publication always needs the
// author's own emailed confirmation, so a delegated credential can never push work public.
const SCOPE_HELP: Record<ApiTokenScope, string> = {
  read: "read your studio, wallet, feed and notifications",
  write: "create, edit and run works; request publication; post, comment, heart, follow",
  economy: "move real value: challenges, coin buy/sell, payouts, bursary applications",
};

function TokenManager() {
  const [items, setItems] = useState<ApiTokenItem[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState<number | "create" | "">("");
  const [creating, setCreating] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(["read", "write"]);
  const [minted, setMinted] = useState<{ token: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [createErr, setCreateErr] = useState("");

  useEffect(() => {
    ApiTokens.list().then((r) => setItems(r.items)).catch(() => setErr(true));
  }, []);

  const toggleScope = (s: ApiTokenScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  async function create() {
    setBusy("create");
    setCreateErr("");
    try {
      const r = await ApiTokens.create(label.trim() || "API token", scopes.length ? scopes : ["read"]);
      setMinted({ token: r.token, label: r.item.label });
      setItems((prev) => (prev ? [r.item, ...prev] : [r.item]));
      setCreating(false);
      setLabel("");
      setCopied(false);
    } catch (e) {
      setCreateErr(e instanceof ApiError ? e.message : "Could not create the token — please try again.");
    } finally { setBusy(""); }
  }
  async function revoke(t: ApiTokenItem) {
    setBusy(t.id);
    try {
      await ApiTokens.revoke(t.id);
      setItems((prev) => (prev ? prev.map((x) => (x.id === t.id ? { ...x, revoked: true } : x)) : prev));
    } catch { setErr(true); } finally { setBusy(""); }
  }

  const active = items?.filter((t) => !t.revoked) ?? [];

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Developers · API tokens</h2>
        <Button variant="outline" onClick={() => { setCreating((v) => !v); setMinted(null); }} className="h-9 px-3 text-[13px]">
          {creating ? "Cancel" : "New token"}
        </Button>
      </div>
      <p className="mt-1 text-[13px] text-ink-3">
        Let scripts and AI agents act as you through the open API — see the <a className="text-yin-light hover:underline" href={localePath("/developers/")}>developer docs</a>.
        Whatever a token does, publishing still requires your own emailed confirmation — the single-use link sent to your registered address — so nothing goes public without you.
      </p>

      {err && <ErrorNote className="mt-4">Something went wrong with your tokens. Please reload the page.</ErrorNote>}

      {minted && (
        <Card className="mt-4 border-yang/40 px-4 py-3">
          <div className="text-[14px] font-semibold text-yang">“{minted.label}” created — copy it now</div>
          <div className="mt-1 text-[12.5px] text-ink-3">This is the only time the token is shown. Treat it like a password; revoke it here any time.</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code data-ay-skip="1" className="break-all rounded bg-space-2 px-2 py-1 text-[13px] text-ink">{minted.token}</code>
            <Button variant="outline" className="h-8 px-3 text-[12px]"
              onClick={() => { navigator.clipboard?.writeText(minted.token).then(() => setCopied(true)); }}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {creating && (
        <Card className="mt-4 px-4 py-4">
          <Field label="Token name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My research agent" maxLength={80} />
          </Field>
          <div className="mt-3 flex flex-col gap-2">
            {(Object.keys(SCOPE_HELP) as ApiTokenScope[]).map((s) => (
              <label key={s} className="flex cursor-pointer items-start gap-2 text-[14px] text-ink-2">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} className="mt-1 accent-[var(--color-yang)]" />
                <span><b className="text-ink">{s}</b> — {SCOPE_HELP[s]}</span>
              </label>
            ))}
          </div>
          {createErr && <ErrorNote className="mt-3">{createErr}</ErrorNote>}
          <Button onClick={create} disabled={busy === "create"} className="mt-4 h-9 px-4 text-[13px]">
            {busy === "create" ? "Creating…" : "Create token"}
          </Button>
        </Card>
      )}

      {!items && !err && <StatusNote className="py-4 text-start">Loading tokens…</StatusNote>}
      {items && items.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((t) => (
            <li key={t.id}>
              <Card className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${t.revoked ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold">{t.label}</span>
                    <code data-ay-skip="1" className="text-[12px] text-ink-3">{t.prefix}</code>
                    {t.scopes.map((s) => <Pill key={s} className="px-2 py-0.5 text-[11px]">{s}</Pill>)}
                    {t.revoked && <Pill className="px-2 py-0.5 text-[11px] text-rose-300">revoked</Pill>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {t.calls} request{t.calls === 1 ? "" : "s"}
                    {t.last_used ? ` · last used ${ago(t.last_used)}` : " · never used"}
                    {t.created ? ` · created ${ago(t.created)}` : ""}
                  </div>
                </div>
                {!t.revoked && (
                  <Button variant="outline"
                    onClick={() => { if (armed === t.id) { setArmed(null); revoke(t); } else { setArmed(t.id); } }}
                    disabled={busy === t.id}
                    className={"h-9 px-3 text-[13px] " + (armed === t.id ? "border-rose-400/60 text-rose-300" : "hover:text-rose-300")}>
                    {busy === t.id ? "Revoking…" : armed === t.id ? "Really revoke? Anything using it stops working" : "Revoke"}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {items && active.length === 0 && !err && !creating && (
        <p className="mt-4 text-[14px] text-ink-3">No active tokens.</p>
      )}
    </section>
  );
}

// ── What your work costs ────────────────────────────────────────────────────
// Charging after the fact is only fair if it can be taken apart, so this shows the parts: what ran,
// for how long, what the AI cost, what the compute cost, and what that came to in coins at the gold
// price of the moment. Nothing here is a price list — there isn't one — so the tier table quotes the
// COMPUTE per minute and says plainly that the AI part is not knowable before the turn runs.
function UsageManager() {
  const [info, setInfo] = useState<UsageInfo | null>(null);
  const [days, setDays] = useState<{ day: string; items: number; total_usd: string; total_coins: string; sent: number }[] | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    UsageApi.mine().then(setInfo).catch(() => setErr(true));
    UsageApi.invoices().then((r) => setDays(r.items)).catch(() => setDays([]));
  }, []);

  const n = (v: string | number, d = 4) => Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <section>
      <h2 className="text-[20px] font-bold tracking-tight">What your work costs</h2>
      <p className="mt-1 text-[13px] text-ink-3">
        You are charged only for what actually ran — a turn when it replies, a session when it ends — from the compute it
        really used and the gold price at the time. Nothing is estimated or held in advance. One ArtaCoin is one milligram
        of gold, and gold has no fractions of a milligram, so usage adds up exactly and only whole coins are taken; the
        remainder carries to the next day rather than being rounded away in either direction.
      </p>

      {err && <ErrorNote className="mt-4">Could not load your usage. Please reload the page.</ErrorNote>}
      {!info && !err && <StatusNote className="py-4 text-start">Loading…</StatusNote>}

      {info && (
        <>
          <div data-ay-skip="1" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Balance" value={`${n(info.balance, 2)} ₳`} sub={info.balance <= info.floor ? "below the floor" : "spendable"} />
            <Stat label="Not yet charged" value={`${n(info.carry)} ₳`} sub="settles daily, in whole coins" />
            <Stat label="One ArtaCoin" value={`$${n(info.coin_usd, 4)}`} sub="1 mg of gold" />
            <Stat label="Gold" value={`$${Number(info.spot).toLocaleString()}`} sub="per troy ounce" />
          </div>

          <Card className="mt-4 px-4 py-3">
            <div className="text-[13px] font-semibold text-ink">What each mode gives you</div>
            <div className="mt-2 overflow-x-auto">
              <table data-ay-skip="1" className="w-full text-[12.5px]">
                <thead className="text-ink-3">
                  <tr><th className="py-1 text-start font-normal">Mode</th><th className="text-start font-normal">Machine</th><th className="text-start font-normal">Max time</th><th className="text-end font-normal">Compute / min</th></tr>
                </thead>
                <tbody>
                  {info.tiers.map((t) => (
                    <tr key={t.key} className="border-t border-line">
                      <td className="py-1.5 text-ink">{t.label}</td>
                      <td className="text-ink-2">{t.cpu} vCPU · {t.ram} GiB</td>
                      <td className="text-ink-2">{Math.round(t.max_secs / 60)} min</td>
                      <td className="text-end tabular-nums text-ink-2">{n(t.compute_coins_per_min)} ₳</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Said plainly, because the compute figure above is the small half of the bill and quoting
                it alone would read like the whole price. */}
            <p className="mt-2 text-[12px] text-ink-3">
              Compute only. What the AI itself costs depends on how much thinking a turn actually needs, so it is measured
              per turn rather than quoted — it is usually most of the bill.
            </p>
          </Card>

          {days && days.length > 0 && (
            <div className="mt-4">
              <div className="text-[13px] font-semibold text-ink">Daily statements</div>
              <ul className="mt-2 flex flex-col gap-2">
                {days.slice(0, 7).map((d) => (
                  <li key={d.day}>
                    <Card className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-[14px] text-ink">{d.day}</span>
                      <span data-ay-skip="1" className="text-[13px] text-ink-3">
                        {d.items} item{d.items === 1 ? "" : "s"} · <b className="text-ink-2">{n(d.total_coins)} ₳</b>
                        {d.sent ? " · emailed" : ""}
                      </span>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex items-baseline justify-between">
            <div className="text-[13px] font-semibold text-ink">Every charge, itemised</div>
            {info.recent.length > 6 && (
              <Button variant="outline" onClick={() => setOpen((v) => !v)} className="h-8 px-3 text-[12px]">
                {open ? "Show less" : `Show all ${info.recent.length}`}
              </Button>
            )}
          </div>
          {info.recent.length === 0 && <p className="mt-2 text-[14px] text-ink-3">Nothing yet.</p>}
          {info.recent.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table data-ay-skip="1" className="w-full text-[12.5px]">
                <thead className="text-ink-3">
                  <tr><th className="py-1 text-start font-normal">When</th><th className="text-start font-normal">Mode</th><th className="text-end font-normal">Time</th><th className="text-end font-normal">AI</th><th className="text-end font-normal">Compute</th><th className="text-end font-normal">Total</th></tr>
                </thead>
                <tbody>
                  {(open ? info.recent : info.recent.slice(0, 6)).map((l) => (
                    <tr key={l.id} className="border-t border-line align-top">
                      <td className="py-1.5 text-ink-3">{when(l.ended ?? 0)}</td>
                      <td className="text-ink-2" title={l.note}>{l.tier}{l.session_id ? ` · #${l.session_id}` : ""}</td>
                      <td className="text-end tabular-nums text-ink-3">{l.secs}s</td>
                      <td className="text-end tabular-nums text-ink-3">${n(l.ai_usd)}</td>
                      <td className="text-end tabular-nums text-ink-3">${n(l.azure_usd, 6)}</td>
                      <td className="text-end tabular-nums text-ink">{n(l.coins)} ₳</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Your machine — a real Linux account, reachable over SSH ─────────────────
// The account is not a shell on ArtaQuest's server: sshd force-commands every session into the SAME
// sandbox ArtaBot's tool turns run in, with the member's own persistent home. So "ask ArtaBot to
// build it, then ssh in and find it" is one workspace, and what a member can reach from a terminal
// is exactly what ArtaBot could already reach on their behalf.
function ShellManager() {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [err, setErr] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState<number | "add" | "">("");
  const [armed, setArmed] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { ShellAccount.mine().then(setInfo).catch(() => setErr(true)); }, []);

  async function add() {
    setBusy("add"); setAddErr("");
    try {
      setInfo(await ShellAccount.addKey(label.trim(), key.trim()));
      setAdding(false); setLabel(""); setKey("");
    } catch (e) {
      setAddErr(e instanceof ApiError ? e.message : "Could not add that key — please try again.");
    } finally { setBusy(""); }
  }
  async function remove(k: ShellKey) {
    setBusy(k.id);
    try { setInfo(await ShellAccount.removeKey(k.id)); } catch { setErr(true); } finally { setBusy(""); }
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Your machine · SSH</h2>
        {info?.unix && (
          <Button variant="outline" onClick={() => setAdding((v) => !v)} className="h-9 px-3 text-[13px]">
            {adding ? "Cancel" : "Add a key"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-3">
        You have your own Linux account on ArtaQuest's machine — a sandbox with a shell, Python, Node, git and the open
        internet. It is the SAME place ArtaBot works when you ask it to build something, so whatever it makes is waiting
        for you here. Your files persist; 2 GB of space. The rest of the machine, this database and everyone else's files
        are out of reach from it, and there are no ArtaQuest credentials inside.
      </p>

      {err && <ErrorNote className="mt-4">Something went wrong loading your shell. Please reload the page.</ErrorNote>}
      {!info && !err && <StatusNote className="py-4 text-start">Loading…</StatusNote>}

      {info?.blocked && <StatusNote className="mt-4 py-3 text-start">{info.blocked}</StatusNote>}

      {info?.unix && (
        <Card className="mt-4 px-4 py-3">
          <div className="text-[13px] text-ink-3">Sign in from your terminal with</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code data-ay-skip="1" className="break-all rounded bg-space-2 px-2 py-1 text-[14px] text-ink">{info.command}</code>
            <Button variant="outline" className="h-8 px-3 text-[12px]"
              onClick={() => { navigator.clipboard?.writeText(info.command).then(() => setCopied(true)); }}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {info.keys.length === 0 && (
            <div className="mt-2 text-[12.5px] text-ink-3">
              Add a key below first — that is what lets you in. On your own computer:{" "}
              <code data-ay-skip="1" className="rounded bg-space-2 px-1.5 py-0.5 text-[12px]">ssh-keygen -t ed25519</code>{" "}
              then paste the contents of <code data-ay-skip="1" className="rounded bg-space-2 px-1.5 py-0.5 text-[12px]">~/.ssh/id_ed25519.pub</code>.
            </div>
          )}
        </Card>
      )}

      {adding && (
        <Card className="mt-4 px-4 py-4">
          <Field label="What is this key for?">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Work laptop" maxLength={60} />
          </Field>
          <Field label="Your PUBLIC key (the .pub file)">
            <textarea value={key} onChange={(e) => setKey(e.target.value)} rows={3} spellCheck={false}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."
              className="w-full rounded-card border border-line bg-space-2 px-3 py-2 font-mono text-[12.5px] text-ink outline-none focus:border-yin" />
          </Field>
          {/* Said plainly because the consequence is permanent: everything in this database is
              published at /data/, so a private key pasted here would be published too. */}
          <p className="mt-2 text-[12.5px] text-ink-3">
            Paste the <b className="text-ink">public</b> half only — the file ending <code data-ay-skip="1">.pub</code>. Never a private key:
            ArtaQuest's whole database is public, so anything you put here is public too.
          </p>
          {addErr && <ErrorNote className="mt-3">{addErr}</ErrorNote>}
          <Button onClick={add} disabled={busy === "add" || !key.trim()} className="mt-4 h-9 px-4 text-[13px]">
            {busy === "add" ? "Adding…" : "Add key"}
          </Button>
        </Card>
      )}

      {info && info.keys.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {info.keys.map((k) => (
            <li key={k.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold">{k.label || "Key"}</div>
                  {/* The fingerprint, so it can be checked against `ssh-keygen -lf` rather than believed. */}
                  <code data-ay-skip="1" className="mt-0.5 block break-all text-[12px] text-ink-3">{k.fp}</code>
                </div>
                <Button variant="outline"
                  onClick={() => { if (armed === k.id) { setArmed(null); remove(k); } else { setArmed(k.id); } }}
                  disabled={busy === k.id}
                  className={"h-9 px-3 text-[13px] " + (armed === k.id ? "border-rose-400/60 text-rose-300" : "hover:text-rose-300")}>
                  {busy === k.id ? "Removing…" : armed === k.id ? "Really remove? That computer stops being able to sign in" : "Remove"}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Passkeys — the publication signing key ──────────────────────────────────
// WebAuthn credentials whose private half lives ONLY in the member's device. Once enrolled,
// publishing requires the device to sign the exact work — a consent no agent, operator or
// server can forge, verifiable by anyone from the public ledger.
const b64uToBuf = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const bufToB64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function PasskeyManager() {
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const supported = typeof window !== "undefined" && !!window.PublicKeyCredential;

  useEffect(() => {
    Passkeys.list().then((r) => setItems(r.items)).catch(() => setMsg("Could not load your passkeys."));
  }, []);

  async function enroll() {
    setBusy(true);
    setMsg("");
    try {
      const o = (await Passkeys.registerOptions()) as {
        challenge: string; rp: { id: string; name: string };
        user: { id: string; name: string; displayName: string };
        pubKeyCredParams: PublicKeyCredentialParameters[]; timeout: number;
        authenticatorSelection: AuthenticatorSelectionCriteria; attestation: AttestationConveyancePreference;
      };
      const cred = (await navigator.credentials.create({
        publicKey: {
          ...o,
          challenge: b64uToBuf(o.challenge),
          user: { ...o.user, id: b64uToBuf(o.user.id) },
        },
      })) as PublicKeyCredential;
      const resp = cred.response as AuthenticatorAttestationResponse;
      await Passkeys.register({
        label: navigator.platform || "Passkey",
        clientDataJSON: bufToB64u(resp.clientDataJSON),
        attestationObject: bufToB64u(resp.attestationObject),
      });
      const r = await Passkeys.list();
      setItems(r.items);
      setMsg("Passkey enrolled — from now on, publishing asks this device to sign your work.");
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Enrollment was cancelled or failed.");
    } finally { setBusy(false); }
  }

  async function revoke(k: PasskeyItem) {
    try {
      await Passkeys.revoke(k.id);
      setItems((prev) => (prev ? prev.map((x) => (x.id === k.id ? { ...x, revoked: true } : x)) : prev));
    } catch { setMsg("Could not revoke — reload and try again."); }
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Publication signing key</h2>
        {supported && (
          <Button variant="outline" onClick={enroll} disabled={busy} className="h-9 px-3 text-[13px]">
            {busy ? "Waiting for your device…" : "Add a passkey"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-3">
        A passkey turns publishing into a cryptographic act: your device signs the exact work being
        published, the signature joins the public record, and no AI agent, script, or even someone with
        full server access can forge it — the private key never leaves your device. Once you have one,
        every publication requires it (alongside your emailed confirmation).
      </p>
      {!supported && <p className="mt-2 text-[13px] text-ink-3">This browser does not support passkeys.</p>}
      {msg && <StatusNote className="mt-3 py-2 text-start">{msg}</StatusNote>}
      {items && items.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((k) => (
            <li key={k.id}>
              <Card className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${k.revoked ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold">{k.label}</span>
                    {k.revoked && <Pill className="px-2 py-0.5 text-[11px] text-rose-300">revoked</Pill>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {k.created ? `enrolled ${ago(k.created)}` : ""}
                    {k.last_used ? ` · last signed ${ago(k.last_used)}` : " · never signed"}
                  </div>
                </div>
                {!k.revoked && (
                  <Button variant="outline"
                    onClick={() => { if (armed === k.id) { setArmed(null); revoke(k); } else { setArmed(k.id); } }}
                    className={"h-9 px-3 text-[13px] " + (armed === k.id ? "border-rose-400/60 text-rose-300" : "hover:text-rose-300")}>
                    {armed === k.id ? "Really revoke this signing key?" : "Revoke"}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {items && items.filter((k) => !k.revoked).length === 0 && (
        <p className="mt-4 text-[14px] text-ink-3">No passkey yet — your publications are protected by email confirmation only.</p>
      )}
    </section>
  );
}

// ── Danger zone · delete account ────────────────────────────────────────────
// Irreversibly purges the member's entire profile from the (public) database — identity, posts,
// progress, certificates. Because that can't be undone, it's guarded by BOTH a typed confirmation
// (the word DELETE) AND a re-auth code emailed to the member (passwordless re-auth), so neither an
// accidental click nor a hijacked live session can trigger it. The backend signs the member out on
// success (Account.php), so we leave the SPA entirely afterwards.
function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"intro" | "code">("intro");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function reset() {
    setOpen(false); setStage("intro"); setCode(""); setConfirm(""); setErr("");
  }
  async function sendCode() {
    setBusy(true); setErr("");
    try {
      const r = await AccountApi.deleteRequest();
      setSentTo(r.email || "your email address");
      setStage("code");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't send the code — please try again.");
    } finally { setBusy(false); }
  }
  async function confirmDelete() {
    if (confirm !== "DELETE" || code.length < 6 || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await AccountApi.deleteConfirm(code, confirm);
      // Account is gone and the server has already signed us out — leave the SPA for the homepage.
      window.location.assign(r.redirect || "/");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't delete your account — please try again.");
      setBusy(false); // keep the panel open so they can retry / re-enter the code
    }
  }

  return (
    <Card as="section" className="flex flex-col gap-3 border-rose-400/25 p-5">
      <h2 className="text-[15px] font-bold text-rose-300">Delete account</h2>
      <p className="text-[13px] leading-relaxed text-ink-3">
        Permanently erase your profile from ArtaQuest — your identity, posts, replies, course progress and certificates. The whole database is public, so this removes you from it for good. It can't be undone.
      </p>

      {!open ? (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)} className="border-rose-400/40 text-rose-300 hover:border-rose-300 hover:text-rose-200">
            Delete my account…
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {stage === "intro" ? (
            <>
              <p className="text-[14px] text-ink-2">
                To be sure it's really you, we'll email a confirmation code to your address. You'll enter it together with the word <strong className="text-ink">DELETE</strong> to finish.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void sendCode()} disabled={busy} className="h-10 px-5 text-[14px]">
                  {busy ? "Sending…" : "Email me a confirmation code"}
                </Button>
                <Button variant="ghost" onClick={reset} disabled={busy} className="h-10 px-4 text-[14px]">Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[14px] text-ink-2">
                We emailed a 6-digit code to <strong className="text-ink">{sentTo}</strong>. Enter it below, type <strong className="text-ink">DELETE</strong> to confirm, then delete your account.
              </p>
              <Field label="Confirmation code">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="bg-space-1 px-3.5 tracking-[0.3em]" />
              </Field>
              <Field label="Type DELETE to confirm">
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="DELETE" className="bg-space-1 px-3.5" />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void confirmDelete()} disabled={busy || confirm !== "DELETE" || code.length < 6}
                  className="h-10 px-5 text-[14px] disabled:opacity-40 hover:text-rose-300">
                  {busy ? "Deleting…" : "Permanently delete my account"}
                </Button>
                <Button variant="ghost" onClick={() => void sendCode()} disabled={busy} className="h-10 px-4 text-[14px]">Resend code</Button>
                <Button variant="ghost" onClick={reset} disabled={busy} className="h-10 px-4 text-[14px]">Cancel</Button>
              </div>
            </>
          )}
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      )}
    </Card>
  );
}

// ── Identity & the blue check ────────────────────────────────────────────────
// Real full name + birthday are required to post (set freely here). The blue check additionally
// confirms a government ID with Claude — ID front/back + a selfie are sent ONCE for the check and
// never stored; only the verdict, name, birthday, and the verified profile photo are kept.
function PhotoTile({ label, hint, value, onPick }: { label: string; hint: string; value?: string; onPick: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <button type="button" onClick={() => ref.current?.click()}
      className="group flex flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-space-2/40 p-3 text-center transition-colors hover:border-yin-light/50">
      {value
        ? <img src={value} alt="" className="h-20 w-full rounded-lg object-cover" />
        : <span className="flex h-20 w-full items-center justify-center text-[22px] text-ink-3" aria-hidden>＋</span>}
      <span className="text-[13px] font-semibold">{label}{value ? " ✓" : ""}</span>
      <span className="text-[11px] text-ink-2">{hint}</span>
      <input ref={ref} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    </button>
  );
}

// Palm "back photo" (ticket #94): an opt-in, public image of the member's open palm that flips into
// view behind their profile picture — a human, self-chosen "I'm a real person" signal, separate from
// the blue-check identity verification. Upload / replace / remove here; the header avatar (which the
// live preview points at) flips the moment it's saved.
function PalmBackPhoto({ user, onChange }: { user: Dashboard["user"]; onChange: (palm: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const palm = user.palm || "";
  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const image = await fileToImage(file, 512, 0.9);
      const r = await VerifyApi.setPalm(image);
      if (typeof r?.palm === "string") onChange(r.palm);
      else setErr(r?.message || r?.error || "Couldn't save that photo.");
    } catch { setErr("Couldn't read that image."); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setErr("");
    try {
      const r = await VerifyApi.removePalm();
      if (r?.ok) onChange("");
      else setErr(r?.message || r?.error || "Couldn't remove that photo.");
    } catch { setErr("Something went wrong — please try again."); }
    finally { setBusy(false); }
  }
  return (
    <section>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <Avatar src={user.avatar} name={user.name} palm={palm || undefined} className="h-20 w-20 shrink-0 ring-2 ring-line" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] font-bold tracking-tight">Palm back photo</h2>
            <p className="mt-1 text-[14px] text-ink-3">
              Add a photo of your open palm as a “back” for your picture. Anyone can tap your profile picture to
              flip it and see your palm — a human, self-chosen sign that you’re a real person. It’s separate from
              the blue-check verification, and public like the rest of your profile. {palm ? "Tap your picture to preview the flip." : ""}
            </p>
            {err && <p className="mt-2 text-[13px] text-yin-light">{err}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => ref.current?.click()} disabled={busy} className="h-9 px-4 text-[13px]">
                {busy ? "Working…" : palm ? "Replace palm photo" : "Add palm photo"}
              </Button>
              {palm && <Button variant="ghost" onClick={() => void remove()} disabled={busy} className="h-9 px-4 text-[13px] hover:text-rose-300">Remove</Button>}
              <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0] || null)} />
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}

function IdentityVerification() {
  const [st, setSt] = useState<VerifyStatus | null>(null);
  const [name, setName] = useState("");
  const [bday, setBday] = useState("");
  const [nat, setNat] = useState("");
  const [idSaving, setIdSaving] = useState(false);
  const [idMsg, setIdMsg] = useState("");
  const [imgs, setImgs] = useState<{ profile_pic?: string; id_front?: string; id_back?: string; selfie?: string }>({});
  const [busy, setBusy] = useState(false);
  const [vmsg, setVmsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Every country, localized + sorted for the active language (no allow-list — see lib/flags.ts).
  const countries = useMemo(() => countryOptions(), []);

  const [gender, setGender] = useState("");
  const load = () => VerifyApi.status().then((s) => {
    if (s && !("error" in s && (s as { error?: string }).error)) {
      setSt(s); setName(s.full_name || ""); setBday(s.birthday || ""); setNat(s.nationality || "");
      setGender(s.gender || "");
    }
  });
  useEffect(() => { load(); }, []);

  /** Gender saves on change (its own route), so choosing "Prefer not to say" revokes it immediately
   *  rather than waiting on a Save the member might never press. */
  function saveGenderNow(g: string) {
    setGender(g);
    setGender_(g === "" ? "clear" : g).then(() => setIdMsg(g === "" ? "Gender removed" : "Saved"), () => setIdMsg("Couldn’t save that — try again."));
  }

  async function saveIdentity() {
    // Check here as well as on the server. The server is the rule (Rest::birthday_gate), but a
    // member who submits an empty date should be told which field, not handed a generic refusal.
    if (!name.trim()) { setIdMsg("Add your full legal name — it is required."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bday)) { setIdMsg("Add your date of birth — every member states one."); return; }
    setIdSaving(true); setIdMsg("");
    const r = await VerifyApi.setIdentity(name.trim(), bday, nat);
    setIdSaving(false);
    if (r.ok) { setIdMsg("Saved"); load(); } else { setIdMsg(r.message || "Couldn't save — check your details."); }
  }
  async function pick(kind: "profile_pic" | "id_front" | "id_back" | "selfie", file: File | null) {
    if (!file) return;
    try { const url = await fileToImage(file); setImgs((p) => ({ ...p, [kind]: url })); } catch { setVmsg({ ok: false, text: "Couldn't read that image." }); }
  }
  async function submit() {
    if (!imgs.profile_pic || !imgs.id_front || !imgs.id_back || !imgs.selfie) { setVmsg({ ok: false, text: "Attach all four photos first." }); return; }
    setBusy(true); setVmsg(null);
    const r = await VerifyApi.verify({ profile_pic: imgs.profile_pic, id_front: imgs.id_front, id_back: imgs.id_back, selfie: imgs.selfie });
    setBusy(false);
    if (r.verified) { setVmsg({ ok: true, text: "Verified — you've earned the blue check." }); setImgs({}); }
    else { setVmsg({ ok: false, text: r.reason || r.message || "We couldn't verify your identity." }); }
    load();
  }

  const ready = !!(imgs.profile_pic && imgs.id_front && imgs.id_back && imgs.selfie);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-[20px] font-bold tracking-tight">
          Identity {st?.verified && <BlueCheck size={18} />}
        </h2>
        <p className="mt-1 text-[13px] text-ink-3">Your real name and birthday are required to post, and are public on your profile. The blue check confirms a government ID — it's required to cash out, and puts your country's flag on your profile picture.</p>
      </div>

      {/* Name + birthday (gates posting) + nationality (needed for the blue check) */}
      <Card as="div" className="flex flex-col gap-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full legal name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="As written on your ID" required />
          </Field>
          {/* MANDATORY, and the form now says so. Rest::birthday_gate refuses EVERY mutation from an
              account with no exact date of birth, so a member who leaves this blank cannot post,
              heart, comment or publish — they simply meet a 403 later instead of a label now.
              "Birthday" also undersold it: this is a date of birth, and it is public. */}
          <Field label="Date of birth" required hint="Public on your profile, and required before you can post.">
            {/* Same three wheels as sign-up — one control for one fact, everywhere it is asked for. */}
            <DobWheel value={bday} onChange={setBday} minYear={new Date().getFullYear() - 120}
              maxYear={new Date().getFullYear() - 13} invalid={bday !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(bday)} />
          </Field>
          <Field label="Nationality" optional>
            <select value={nat} onChange={(e) => setNat(e.target.value)} aria-label="Nationality"
              className="h-11 w-full rounded-field border border-line bg-space-1 px-3.5 text-[15px] text-ink outline-none focus:border-yin-light">
              <option value="">Choose your nationality…</option>
              {/* Revocable: CLEAR is the sentinel Verify::set_identity deletes on. Without a way to
                  take it back the claim was write-only, which matters now that a donor's ArtaCredit
                  can be aimed at a nationality. */}
              {st?.nationality && <option value="CLEAR">Remove my nationality</option>}
              {countries.map((c) => <option key={c.code} value={c.code}>{`${flagEmoji(c.code)} ${c.name}`}</option>)}
            </select>
          </Field>
          {/* GENDER — the only axis of a donor's ArtaCredit that ArtaQuest does not otherwise know.
              Opt-in, revocable, never inferred, and useless for anything else: it is read by exactly
              one thing (Credits::buckets_for_user). Saying nothing is a complete answer. */}
          <Field label="Gender" optional hint="Public, like everything on ArtaQuest. Used only so a donor’s gift can find the members it was given for.">
            <select value={gender} onChange={(e) => saveGenderNow(e.target.value)} aria-label="Gender"
              className="h-11 w-full rounded-field border border-line bg-space-1 px-3.5 text-[15px] text-ink outline-none focus:border-yin-light">
              <option value="">Prefer not to say</option>
              <option value="w">Woman</option>
              <option value="m">Man</option>
              <option value="n">Non-binary</option>
            </select>
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={saveIdentity} disabled={idSaving} className="h-10 px-4 text-[14px]">{idSaving ? "Saving…" : "Save"}</Button>
          {idMsg && <span className="text-[13px] text-ink-3">{idMsg}</span>}
          {st && !st.has_identity && <span className="text-[13px] text-rose-300">Required before you can post</span>}
        </div>
      </Card>

      {/* Blue check verification */}
      <Card as="div" className="flex flex-col gap-3 p-5">
        {st?.verified ? (
          <div className="flex items-center gap-2 text-[15px] font-semibold text-yin-light">
            <BlueCheck size={18} /> Verified{st.verified_at ? ` · ${new Date(st.verified_at * 1000).toLocaleDateString()}` : ""}
            {flagEmoji(st.nationality) && (
              <span role="img" aria-label={countryName(st.nationality)} title={`${countryName(st.nationality)} — shown on your profile picture`} className="text-[17px] leading-none">
                {flagEmoji(st.nationality)}
              </span>
            )}
          </div>
        ) : !st?.configured ? (
          <p className="text-[14px] text-ink-3">Identity verification is temporarily unavailable. Please check back soon.</p>
        ) : !st?.has_identity || !st?.nationality ? (
          <p className="text-[14px] text-ink-3">Save your full name, birthday and nationality above first, then verify your ID.</p>
        ) : (
          <>
            <h3 className="text-[16px] font-bold">Get the blue check</h3>
            <p className="text-[13px] text-ink-3">Verifying is free. Add a clear photo of your face (becomes your profile picture), the front and back of a government ID from any country, and a selfie. Claude confirms the ID is genuine and that the name, birthday, nationality, and face all match. Once verified, your country's flag appears on your profile picture across ArtaQuest. Your ID and selfie are used only for this check and are never stored.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <PhotoTile label="Profile photo" hint="your face" value={imgs.profile_pic} onPick={(f) => pick("profile_pic", f)} />
              <PhotoTile label="ID front" hint="government ID" value={imgs.id_front} onPick={(f) => pick("id_front", f)} />
              <PhotoTile label="ID back" hint="government ID" value={imgs.id_back} onPick={(f) => pick("id_back", f)} />
              <PhotoTile label="Selfie" hint="holding still" value={imgs.selfie} onPick={(f) => pick("selfie", f)} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={busy || !ready} className="h-10 px-5 text-[14px]">
                {busy ? "Verifying…" : "Verify"}
              </Button>
            </div>
          </>
        )}
        {vmsg && <p className={`text-[14px] ${vmsg.ok ? "text-yin-light" : "text-rose-300"}`}>{vmsg.text}</p>}
      </Card>
    </section>
  );
}

// ── Kaggle handle — the account whose notebooks you may submit ──────────────
// Publishing mints a permanent DOI that credits the notebook's KAGGLE author, so the platform has
// to know that author is you. The proof reads Kaggle's public API with no credential at all: we
// mint a one-time string and keep only its sha256, the member puts it in a public notebook under
// the handle, and we read it back — a check any stranger can repeat against the same kernel.

/** Kaggle's own path segments — never a username, so a half-pasted URL can't be claimed as one. */
const KAGGLE_SECTIONS = /^(code|datasets|models|competitions|discussions|organizations|learn|work)$/;

/** Accept a bare handle, an @handle, or a pasted Kaggle URL (profile, /code/… or the legacy
 *  owner/slug shape) — all of them name the same account, and members paste all three. A URL we
 *  cannot read an owner out of gives '' rather than a handle made of its own characters. */
function kaggleHandle(v: string) {
  const s = v.trim().replace(/^@+/, "");
  const looksUrl = /^https?:\/\//i.test(s) || /kaggle\.com\//i.test(s);
  const m = s.match(/kaggle\.com\/(?:code\/|datasets\/|models\/)?([^/?#]+)/i);
  const h = (looksUrl ? (m ? m[1] : "") : s).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return KAGGLE_SECTIONS.test(h) ? "" : h;
}
const kernelLink = (u: string) => (/^https?:\/\//i.test(u) ? u : "");

function KaggleIdentity() {
  const [items, setItems] = useState<KaggleIdItem[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [handle, setHandle] = useState("");
  const [proving, setProving] = useState("");   // the handle the paste-back form is aimed at
  // The minted string, held in memory only — the server kept a hash, so once this is gone it is
  // gone for everyone. Never persisted anywhere.
  const [proof, setProof] = useState<{ handle: string; proof: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"" | "claim" | "verify">("");
  // `at` decides whether the "check all of these" list belongs under the message: it answers a
  // failed READ of the notebook, and would be noise under a refused claim.
  const [err, setErr] = useState<{ at: "claim" | "verify"; text: string } | null>(null);
  const [done, setDone] = useState("");
  // The field holds what the member typed; the handle is DERIVED for display and for the call, so a
  // half-typed URL is never rewritten under their cursor.
  const wanted = kaggleHandle(handle);

  const load = () =>
    KaggleIds.list().then((r) => { setItems(r.items); setLoadErr(false); }).catch(() => setLoadErr(true));
  useEffect(() => { void load(); }, []);

  async function claim(raw: string) {
    const name = kaggleHandle(raw);
    if (!name || busy) return;
    setBusy("claim"); setErr(null); setDone(""); setCopied(false); setUrl("");
    try {
      const r = await KaggleIds.claim(name);
      setProof({ handle: r.handle || name, proof: r.proof });
      setProving(r.handle || name);
      void load();
    } catch (e) {
      setErr({ at: "claim", text: e instanceof ApiError ? e.message : "Could not start that claim — please try again." });
    } finally { setBusy(""); }
  }

  async function verify() {
    if (!proving || !url.trim() || busy) return;
    setBusy("verify"); setErr(null); setDone("");
    try {
      const r = await KaggleIds.verify(proving, url.trim());
      if (r.state === "verified") {
        setDone(`@${r.handle || proving} is yours — you can submit its notebooks`);
        setProof(null); setProving(""); setUrl(""); setHandle("");
      } else {
        // Kaggle answered and the handle is still pending — the proof was not in what it gave us.
        setErr({ at: "verify", text: "We read that notebook but did not find your string in it." });
      }
      void load();
    } catch (e) {
      setErr({ at: "verify", text: e instanceof ApiError ? e.message : "Could not check that notebook — please try again." });
    } finally { setBusy(""); }
  }

  return (
    <section>
      <h2 className="text-[20px] font-bold tracking-tight">Your Kaggle handle</h2>
      <p className="mt-1 text-[13px] text-ink-3">
        Publishing a work mints a permanent DOI crediting the notebook's Kaggle author, so we only accept
        notebooks from an account you have proved is yours. Type your Kaggle username, copy the one-time
        string, paste it into any public notebook of yours on Kaggle, then paste that notebook's URL back
        here. We read the notebook with no login at all, exactly as any stranger can.
      </p>

      {loadErr && <ErrorNote className="mt-4">We couldn't load your handles. Please reload the page.</ErrorNote>}
      {!items && !loadErr && <StatusNote className="py-4 text-start">Loading handles…</StatusNote>}
      {done && <StatusNote className="mt-3 py-2 text-start text-yang-ink">{done}</StatusNote>}

      {items && items.length > 0 && (
        <ul className="mt-4 flex list-none flex-col gap-3 p-0">
          {items.map((k) => (
            <li key={k.handle}>
              <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={`https://www.kaggle.com/${k.handle}`} target="_blank" rel="noopener noreferrer"
                      data-ay-skip="1" className="text-[15px] font-semibold hover:text-yang">@{k.handle}</a>
                    {k.state === "verified"
                      ? <Pill className="px-2 py-0.5 text-[11px]">proved</Pill>
                      : <Pill className="bg-yin/15 px-2 py-0.5 text-[11px] text-yin-ink">not proved yet</Pill>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {k.state === "verified" ? (
                      <>
                        {k.verified_at ? `proved ${ago(k.verified_at)}` : "proved"}
                        {kernelLink(k.proof_kernel) && (
                          <> · <a className="text-yin-light hover:underline" href={kernelLink(k.proof_kernel)}
                            target="_blank" rel="noopener noreferrer">the notebook we read it from</a></>
                        )}
                      </>
                    ) : "Waiting for your string to appear in a public notebook under this handle"}
                  </div>
                </div>
                {k.state !== "verified" && proving !== k.handle && (
                  <Button variant="outline" onClick={() => { setProving(k.handle); setErr(null); setDone(""); }}
                    className="h-9 px-3 text-[13px]">Finish proving it</Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* Claim — a first handle, or another one. */}
      <Card className="mt-4 px-4 py-4">
        <Field label="Kaggle username"
          hint={wanted && wanted !== handle.trim()
            ? <>This claims @<span data-ay-skip="1">{wanted}</span></>
            : "A profile or notebook URL works too — we take the username out of it."}>
          <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your-kaggle-username"
            maxLength={300} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="bg-space-1 px-3.5" />
        </Field>
        <Button variant="outline" onClick={() => void claim(handle)} disabled={!wanted || busy === "claim"}
          className="mt-4 h-9 px-4 text-[13px] disabled:opacity-40">
          {busy === "claim" ? "Minting…" : "Get my one-time string"}
        </Button>
      </Card>

      {proving && (
        <Card className={`mt-3 px-4 py-4 ${proof ? "border-yang/40" : ""}`}>
          {proof && proof.handle === proving ? (
            <>
              <div className="text-[14px] font-semibold text-yang-ink">Your string for @<span data-ay-skip="1">{proving}</span> — copy it now</div>
              <div className="mt-1 text-[12.5px] text-ink-3">
                This is the only time it is shown: we keep just a fingerprint of it, so nobody here can read it
                back to you. Lose it and you claim again for a new one.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code data-ay-skip="1" className="break-all rounded bg-space-2 px-2 py-1 text-[13px] text-ink">{proof.proof}</code>
                <Button variant="outline" className="h-8 px-3 text-[12px]"
                  onClick={() => { navigator.clipboard?.writeText(proof.proof).then(() => setCopied(true)).catch(() => {}); }}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </>
          ) : (
            <div className="text-[13px] text-ink-3">
              You claimed @<span data-ay-skip="1" className="font-semibold text-ink">{proving}</span> earlier. Your string was shown once
              and we cannot show it again —{" "}
              <button type="button" onClick={() => void claim(proving)} disabled={busy === "claim"} className="text-yin-light hover:underline">
                claim again for a new one
              </button>{" "}
              if you no longer have it. The old string stops working the moment you do.
            </div>
          )}

          <Field className="mt-4" label="The notebook you put it in"
            hint="Any public notebook under this handle — the string can sit in a cell or in the title.">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url"
              placeholder="https://www.kaggle.com/code/…" autoCapitalize="none" autoCorrect="off"
              spellCheck={false} className="bg-space-1 px-3.5" />
          </Field>
          <Button onClick={() => void verify()} disabled={!url.trim() || busy === "verify"}
            className="mt-4 h-10 px-5 text-[14px] disabled:opacity-40">
            {busy === "verify" ? "Reading Kaggle…" : "Check it"}
          </Button>
        </Card>
      )}

      {err && (
        <>
          <ErrorNote className="mt-3">{err.text}</ErrorNote>
          {err.at === "verify" && (
            <ul className="mt-2 flex list-none flex-col gap-1 p-0 text-[13px] text-ink-3">
              <li>The notebook is public and saved — Kaggle answers for a private, draft or deleted one the same way, and we can read none of them</li>
              <li>It belongs to @<span data-ay-skip="1">{proving}</span> — a notebook you can edit but do not own says nothing about the account</li>
              <li>The string is somewhere in it: any cell, or the title, exactly as it was given to you</li>
              <li>Nobody else has proved that handle already — only one member can hold it. If it is truly yours, <a className="text-yin-light hover:underline" href={localePath("/issues/")}>report an issue</a></li>
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// "Help grow the fund" — shown when the bursary fund can't cover a place. Turns a
// dead-end into a one-minute way to refill it: ready-to-share posts + share links.
function GrowFund({ share, donateUrl, note }: { share: ShareKit; donateUrl: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const post = `${share.message} ${share.url}`;
  const channels: { key: keyof ShareKit["links"]; label: string }[] = [
    { key: "x", label: "Share on X" }, { key: "facebook", label: "Facebook" },
    { key: "linkedin", label: "LinkedIn" }, { key: "whatsapp", label: "WhatsApp" },
  ];
  return (
    <Card data-goal="bursary-grow" className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[20px] font-bold tracking-tight">The bursary fund is empty right now</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{note || "Bursaries are paid from donations, and there isn't enough in the fund to cover a place today."} You can change that in a minute — share ArtaQuest and a donor can open the door, for you and others.</p>
      </div>
      <div className="rounded-field border border-line bg-space-1 p-4 text-[14px] leading-relaxed text-ink-2">{post}</div>
      <div className="flex flex-wrap gap-2">
        {channels.map((c) => (
          <Button key={c.key} href={share.links[c.key]} target="_blank" rel="noopener noreferrer" variant="outline" className="h-10 px-4 text-[14px]">{c.label}</Button>
        ))}
        <Button onClick={() => { navigator.clipboard?.writeText(post).then(() => setCopied(true)).catch(() => {}); }} variant="outline" className="h-10 px-4 text-[14px]">{copied ? "Copied ✓" : "Copy post"}</Button>
      </div>
      <Button href={localePath(donateUrl.replace(/^https?:\/\/[^/]+/, "")) || "/donate/"} data-goal="bursary-donate" className="h-11 px-6 text-[15px]">Or donate to the fund</Button>
      <p className="text-[12px] text-ink-3">When the fund can cover a place again, this becomes the application form automatically.</p>
    </Card>
  );
}

// Apply for a bursary — covers a course's entry fee from the bursary fund for learners
// in an eligible group. Bursaries are only offered when the fund can actually pay
// (never promise a place the books can't cover); otherwise we ask for help growing it.
function BursaryApply() {
  const sp = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const [courses, setCourses] = useState<CourseCard[]>([]);
  const [courseId, setCourseId] = useState<number>(Number(sp.get("course")) || 0);
  const [group, setGroup] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<BursaryResult | null>(null);
  const [status, setStatus] = useState<BursaryStatus | null>(null);
  useEffect(() => {
    getCourseCards("", null).then((r) => { setCourses(r.items); setCourseId((c) => c || (r.items[0]?.id ?? 0)); }).catch(() => {});
    Funds.bursaryStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  async function apply() {
    if (!courseId || !group || busy) return;
    setBusy(true); setRes(null);
    try { setRes(await Funds.bursaryApply(courseId, group, reason.trim())); }
    catch { setRes({ ok: false, message: "Something went wrong — please try again." }); }
    finally { setBusy(false); }
  }

  // The fund can't cover a place → show the grow-the-fund call to action instead of
  // the form (either known upfront from /bursary/status, or returned by an apply).
  const fundShare = res?.fund_empty ? res.share : (status && !status.available ? status.share : null);
  if (fundShare) return <GrowFund share={fundShare} donateUrl={status?.donate_url || "/donate/"} note={res?.fund_empty ? res.message : undefined} />;

  const cls = "h-11 w-full rounded-field border border-line bg-space-1 px-3.5 text-[15px] text-ink outline-none focus:border-yin-light";
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[20px] font-bold tracking-tight">Apply for a bursary</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-2">Reading, playing and running every work is always free. Where an entry fee is a barrier, a bursary from the member fund covers it in full — usually within a day. The process is confidential.</p>
      </div>
      {res?.ok ? (
        <div data-goal="bursary-granted" className="rounded-field border border-yang/40 bg-yang/[0.06] p-4">
          <p className="text-[15px] font-semibold text-yang">{res.already ? "You already have a bursary for this course." : "Access granted — you can start the course now."}</p>
          {res.course && <p className="mt-1 text-[13px] text-ink-2">{res.course}{res.group ? ` · ${res.group}` : ""}</p>}
          <Button href={localePath("/courses/")} className="mt-3 h-10 px-5 text-[14px]">Browse courses</Button>
        </div>
      ) : (
        <>
          <Field label="Course">
            <select value={courseId} onChange={(e) => setCourseId(Number(e.target.value))} className={cls}>
              {courses.length === 0 && <option value={0}>Loading courses…</option>}
              {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </Field>
          <Field label="Which group do you belong to?">
            <select data-goal="bursary-group" value={group} onChange={(e) => setGroup(e.target.value)} className={cls}>
              <option value="">Choose an eligibility group…</option>
              {BURSARY_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </Field>
          <Field label="Anything we should know?" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={600} placeholder="A sentence on your situation helps, but isn't required." className="w-full resize-y" />
          </Field>
          {res && !res.ok && <p className="text-[13px] text-yin-light">{res.message || res.error || "Couldn't submit — please try again."}</p>}
          <Button data-goal="bursary-apply" onClick={apply} disabled={busy || !courseId || !group} className="h-11 px-6 text-[15px] disabled:opacity-50">{busy ? "Applying…" : "Apply for a bursary"}</Button>
        </>
      )}
    </Card>
  );
}

/** Every challenge this member has entered, and the Certificate of Participation each one carries.
 *  Without this the certificate was reachable only from the transient note shown the moment you
 *  entered — a permanent, verifiable document with no way back to it. */
function ParticipationCerts() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof myParticipation>>["items"]>([]);
  useEffect(() => { myParticipation().then((r) => setItems(r.items)).catch(() => {}); }, []);
  if (!items.length) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-bold tracking-tight">Your certificates</h2>
        <span className="text-[13px] text-ink-2">{items.length} challenge{items.length === 1 ? "" : "s"} entered</span>
      </div>
      <ul className="mt-4 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
        {items.map((c) => (
          <li key={c.challenge_id}>
            <Card as="a" href={localePath(c.url)} className="group block w-full px-4 py-3 hover:border-yin-light/40">
              <span className="block truncate text-[15px] font-semibold transition-colors group-hover:text-yang" data-ay-skip="1">{c.challenge}</span>
              <span className="mt-0.5 block text-[12px] text-ink-2">
                <span data-ay-skip="1">{c.kind} · {c.topic}</span> ·{" "}
                {c.settled ? "settled at its full moon" : "open until its full moon"}
              </span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Account() {
  // `acct` (not the legacy `ay_acct` — the i18n layer strips `ay_*` query params).
  const acct = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("acct") : null;
  const [d, setD] = useState<Dashboard | null>(null);
  // Open the editor directly when arrived from the user-drawer "Settings" link (?settings=1).
  const [editing, setEditing] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("settings"));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (isLoggedIn()) { getDashboard().then((x) => { setD(x); setLoaded(true); }).catch(() => setLoaded(true)); }
    else { setLoaded(true); }
  }, []);

  // Change just the avatar — one click on the camera badge, pick a file, done.
  // No identity re-verify (the blue check is name+birthday+realness, independent
  // of the photo). The header updates immediately on success.
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoErr, setPhotoErr] = useState("");
  async function changePhoto(file: File | null) {
    if (!file) return;
    setPhotoBusy(true); setPhotoErr("");
    try {
      const image = await fileToImage(file, 512, 0.9);
      const r = await VerifyApi.setPhoto(image);
      if (r?.avatar) setD((prev) => (prev ? { ...prev, user: { ...prev.user, avatar: r.avatar! } } : prev));
      else setPhotoErr(r?.message || r?.error || "Couldn't update your photo.");
    } catch { setPhotoErr("Couldn't read that image."); }
    finally { setPhotoBusy(false); }
  }

  if (!isLoggedIn()) {
    return <SignInGate title="Your account" body="Sign in to see your courses, coins, and certificates." />;
  }
  if (!d) {
    // Loaded but no dashboard (e.g. session expired / not really authed) — don't hang on a spinner.
    return loaded
      ? <SignInGate title="Your account" body="We couldn't load your account. Please sign in again." />
      : <StatusNote className="py-16">Loading…</StatusNote>;
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar src={d.user.avatar} name={d.user.name} palm={d.user.palm} className="h-16 w-16 ring-2 ring-line" />
            <button type="button" data-goal="change-photo" onClick={() => photoRef.current?.click()} disabled={photoBusy}
              aria-label="Change profile picture" title="Change profile picture"
              className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border border-line bg-space-2 text-ink-2 shadow-md transition-colors hover:border-yang/50 hover:text-yang disabled:opacity-50">
              {photoBusy
                ? <svg viewBox="0 0 24 24" width="13" height="13" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-6.2-8.5" strokeLinecap="round" /></svg>
                : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>}
            </button>
            <input ref={photoRef} type="file" accept="image/*" className="hidden" onChange={(e) => changePhoto(e.target.files?.[0] || null)} />
          </div>
          <div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight">{d.user.name}</h1>
            {photoErr && <p className="mt-0.5 text-[12px] text-yin-light">{photoErr}</p>}
            <div className="mt-1 flex items-center gap-2">
              {d.tier.next
                ? <Pill className="px-3 py-0.5 text-[13px]">{d.tier.pct}% to {d.tier.next}</Pill>
                : <Pill className="px-3 py-0.5 text-[13px]">Top tier</Pill>}
              {d.user.slug && <a href={localePath(`/u/${d.user.slug}/`)} className="text-[13px] text-ink-3 hover:text-yang">View public profile →</a>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditing((v) => !v)} aria-pressed={editing} className="h-10 px-4 text-[14px]">{editing ? "Close" : "Edit profile"}</Button>
          <Button variant="outline" href="/issues/" className="h-10 px-4 text-[14px]">Report an issue</Button>
          {/* Immediate sign-out via the API (#42) — the WP logout URL's baked nonce can be stale
              (SW-cached shell) and would stop at WP's confirmation page instead of logging out. */}
          <Button variant="outline" onClick={() => void signOut()} className="h-10 px-4 text-[14px] hover:text-rose-300">Log out</Button>
        </div>
      </header>

      {/* "Apply for a bursary" buttons across the app link here (?ay_acct=bursary) —
          surface the application form so the goal is actually reachable. */}
      {acct === "bursary" && <BursaryApply />}

      {/* Keep the editor OPEN after a save so the form's "Saved" confirmation actually shows (and
          Save disables, since it's no longer dirty) — auto-closing swallowed the only feedback a bio
          edit gets. The updated d.user flows back so the header reflects a new name immediately; the
          user closes the editor via the header toggle when done. */}
      {editing && <SettingsForm user={d.user} onSaved={(name, bio, slug) => setD({ ...d, user: { ...d.user, name, bio, slug: slug || d.user.slug } })} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* The four real tiles getDashboard composes: Courses, Completed, Points, Coins —
            grid-cols-2 → lg:grid-cols-4 fills every row evenly (no orphan tile / empty column). */}
        {d.stats.map((s) => <Stat key={s.label} label={s.label} value={s.value} sub={s.sub} />)}
      </div>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[20px] font-bold tracking-tight">Your courses</h2>
          {d.courses.some((c) => c.cert) && (
            <span className="text-[13px] font-semibold text-yang">{d.courses.filter((c) => c.cert).length} certificate{d.courses.filter((c) => c.cert).length === 1 ? "" : "s"} earned</span>
          )}
        </div>
        {d.courses.length === 0 ? (
          <p className="mt-3 text-[15px] text-ink-3">You have not joined a course yet. <a href={localePath("/courses/")} className="text-yang hover:underline">Browse courses →</a></p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {d.courses.map((c) => (
              <li key={c.url} className="flex flex-col items-start gap-1.5">
                <Card as="a" href={localePath(c.url)} className="group block w-full px-4 py-3 hover:border-yin-light/40">
                  <span className="block text-[15px] font-semibold transition-colors group-hover:text-yang">{c.value}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-3">{c.pct ?? 0}% complete{c.lessons ? ` · ${c.lessons} video${c.lessons === 1 ? "" : "s"}` : ""}</span>
                </Card>
                {c.cert && <CertBadge course={c.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ParticipationCerts />

      <PalmBackPhoto user={d.user} onChange={(palm) => setD((prev) => (prev ? { ...prev, user: { ...prev.user, palm } } : prev))} />

      <IdentityVerification />

      <KaggleIdentity />

      <SessionManager />

      <TokenManager />
      <UsageManager />
      <ShellManager />
      <PasskeyManager />

      <DeleteAccount />
    </div>
  );
}
