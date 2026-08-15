/**
 * Offline downloads — what this device keeps when there is no connection.
 *
 * Rewritten 2026-07-29 for the current content model. The page used to be built around COURSES
 * (pick courses → choose a video quality and a subtitle language → save them, plus a desktop
 * downloader script). Courses were purged on 2026-07-13; `offline/manifest` has reported
 * `course_count: 0` ever since, so that entire half rendered a search box, twenty-four topic chips
 * and a quality selector over nothing. It is gone.
 *
 * What is offline-able now, and where each part actually lives:
 *   - **The app itself** — every route chunk, fonts and map data, precached by the service worker.
 *     This is the one that makes the difference: without it a cold launch with no signal is a blank
 *     page, however much media the device holds.
 *   - **A language pack** — so the interface reads in the member's own language with no network.
 *   - **Media** — audio, video, books and PDFs saved out of the Library into IndexedDB, listed and
 *     played at /my-library/. That store is owned by `lib/media-store.ts` and the player, NOT by
 *     `lib/offline/store.ts`; this page links to it rather than duplicating it, because two
 *     download buttons writing to two different stores is how a member ends up with a track they
 *     can see in one place and not the other.
 *   - **The full public database** — radical transparency, readable on a plane.
 *
 * What is NOT offline, and what this page must therefore never promise: the API RESPONSE cache
 * (`STORES.responses` in `lib/offline/store.ts`, the store `lib/offline/fetch` reads on a GET) has no
 * live writer. Its only two `idb.put` calls sit inside `downloadCourse()`, and nothing has called
 * that since the courses were purged. So every data-backed surface — the feed, a work, the Library,
 * a profile, the Studio — still needs a connection, and the copy says exactly that instead of the
 * old "everything works offline except posting, hearting and publishing", which a member could
 * disprove by turning off the wifi and opening the feed. The course machinery stays where it is: an
 * offline FEED is the same shape (bundle the endpoints, write them to this store), so deleting it
 * would only mean writing it again.
 *
 * Music keeps playing with the screen off because `components/player.tsx` publishes MediaSession
 * metadata and the `PlayerProvider` is mounted at the app root, so the audio element outlives
 * navigation. Nothing on this page is needed for that — it is worth saying so plainly here,
 * because "will it stop when I lock my phone?" is the question a runner actually has.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Card, ErrorNote, Field, LinkButton, OrbitRings, PageHero } from "../components/ui";
import {
  getManifest, downloaded, downloadLangPack, removeLangPack,
  downloadDatabase, removeDatabase, clearAll, storageEstimate,
  downloadAppFiles, appFilesStatus, removeAppFiles,
  type Manifest, type SavedLang, type SavedDb, type Progress,
} from "../lib/offline/store";
import { isOnline, onConnectivity } from "../lib/offline/net";
import { currentLang } from "../lib/i18n";
import { listItems, type MediaItem } from "../lib/media-store";

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

type InstallEvt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const UA = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isIOS = /iphone|ipad|ipod/i.test(UA);
const isStandalone = typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true);

export default function Offline() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [online, setOnline] = useState(isOnline());

  const [siteLang, setSiteLang] = useState<string>(() => currentLang());

  // Downloaded state
  const [savedLangs, setSavedLangs] = useState<SavedLang[]>([]);
  const [savedDb, setSavedDb] = useState<SavedDb | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number; persisted: boolean }>({ usage: 0, quota: 0, persisted: false });
  const [appStatus, setAppStatus] = useState<{ total: number; have: number; bytes: number; complete: boolean }>({ total: 0, have: 0, bytes: 0, complete: false });
  // The device media shelf (IndexedDB, owned by media-store) — counted here, managed at /my-library/.
  const [media, setMedia] = useState<{ n: number; bytes: number; playable: number }>({ n: 0, bytes: 0, playable: 0 });

  // Activity
  const [busy, setBusy] = useState<string>("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [installEvt, setInstallEvt] = useState<InstallEvt | null>(null);

  const refreshLocal = useCallback(async () => {
    const [langs, db, est, app] = await Promise.all([
      downloaded.langs(), downloaded.db(), storageEstimate(), appFilesStatus(),
    ]);
    setSavedLangs(langs);
    setSavedDb(db ?? null);
    setUsage(est);
    setAppStatus(app);
    // The device shelf lives in a different store and may be empty or unavailable (private mode) —
    // never let it take the rest of the page down with it.
    try {
      const items: MediaItem[] = await listItems();
      setMedia({
        n: items.length,
        bytes: items.reduce((a, i) => a + (i.size || 0), 0),
        playable: items.filter((i) => i.kind === "music" || i.kind === "video").length,
      });
    } catch { /* no device shelf on this browser — the card simply reads zero */ }
  }, []);

  // Make the whole app available offline (precache every route chunk + fonts + map data).
  const getAppFiles = () =>
    run("app", async () => {
      await downloadAppFiles((p) => setProgress(p));
      setMsg("The whole app is saved on this device — it opens and runs with no internet. Pages that read live data, like the feed, still need a connection.");
    });

  useEffect(() => {
    getManifest().then(setManifest).catch(() => setFailed(true));
    refreshLocal();
    document.title = "Offline downloads – ArtaQuest";
    const off = onConnectivity(setOnline);
    const onBip = (e: Event) => { e.preventDefault(); setInstallEvt(e as InstallEvt); };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => { off(); window.removeEventListener("beforeinstallprompt", onBip); };
  }, [refreshLocal]);

  const langName = useCallback((code: string) => manifest?.languages.find((l) => l.code === code)?.native || code, [manifest]);

  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setMsg(""); setProgress(null);
    try {
      await fn();
      await refreshLocal();
    } catch {
      setMsg("Something went wrong with that download. Check your connection and try again.");
    } finally {
      setBusy(""); setProgress(null);
    }
  }

  // Only the language and database sections need the manifest (it lists the packs and the tables).
  // Everything else — storage in use, install, the app-shell precache, the device media shelf — is
  // read from THIS device and must still render when the fetch fails, because the fetch failing is
  // usually the member being offline, and this is the page they opened to deal with exactly that.
  // `manifestCache` is in-memory only, so a cold offline launch always lands here.
  if (!manifest && !failed) {
    return <div className="grid place-items-center py-24"><OrbitRings className="h-10 w-10" /></div>;
  }

  return (
    <div className="space-y-10">
      <PageHero
        eyebrow="Offline"
        title="Use ArtaQuest with no internet"
        lede="Save the app, your language, your media and the public database onto this device — made for places where the internet is slow, costly, or blocked. Those four work with no connection at all. The feed and everything else that reads live data still needs one."
      />

      {/* Connectivity + install + storage */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Status</p>
          <p className="mt-1 flex items-center gap-2 text-[15px] font-semibold">
            <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-yang" : "bg-ink-3"}`} aria-hidden />
            {online ? "Online — ready to download" : "Offline — saved content works"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Storage used</p>
          <p className="mt-1 text-[15px] font-semibold"><bdi dir="ltr" data-ay-skip="1">{fmtBytes(usage.usage)}{usage.quota ? <span className="text-ink-3"> / {fmtBytes(usage.quota)}</span> : null}</bdi></p>
          {usage.quota > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-veil/10">
              <div className="h-full rounded-pill bg-gradient-to-r from-yang to-yin" style={{ width: `${Math.min(100, (usage.usage / usage.quota) * 100)}%` }} />
            </div>
          )}
        </Card>
        <Card className="p-4">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Install app</p>
          {isStandalone ? (
            <p className="mt-1 text-[13px] text-ink-3">Installed — running as an app ✓</p>
          ) : installEvt ? (
            <Button size="sm" className="mt-1.5 h-8" onClick={async () => { await installEvt.prompt(); await installEvt.userChoice.catch(() => null); setInstallEvt(null); }}>Add to home screen</Button>
          ) : isIOS ? (
            <p className="mt-1 text-[13px] text-ink-3">iPhone/iPad: tap <strong className="text-ink-2">Share</strong> → <strong className="text-ink-2">Add to Home Screen</strong> to install (keeps your downloads).</p>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">Use your browser's <strong className="text-ink-2">Install</strong> / <strong className="text-ink-2">Add to Home Screen</strong> (Chrome, Edge, Safari) to keep ArtaQuest one tap away on Android, Mac and Windows.</p>
          )}
        </Card>
      </div>

      {/* App for offline — precache the WHOLE app so every page works with no internet, on any device. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[15px] font-semibold">
              <span className={`h-2.5 w-2.5 rounded-full ${appStatus.complete ? "bg-yang" : "bg-ink-3"}`} aria-hidden />
              {appStatus.complete ? "App saved — it opens and runs with no internet" : "Save the whole app onto this device"}
            </p>
            <p className="mt-1 text-[13px] text-ink-3">
              Saves the entire app — every page, math fonts and maps — onto this device (~{fmtBytes(appStatus.bytes || 4_000_000)}), so it opens straight away with no connection instead of a blank screen. What each page then shows you depends on what else you have saved: your language, your media and the public database below. Live pages, like the feed, wait for a connection. Works on Android, iPhone/iPad, Mac and Windows.
              {appStatus.total > 0 && !appStatus.complete ? ` (${appStatus.have}/${appStatus.total} files cached)` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {appStatus.complete && <LinkButton onClick={() => run("rm", removeAppFiles)}>Remove</LinkButton>}
            <Button onClick={getAppFiles} disabled={!!busy || !online}>
              {busy === "app" ? (progress ? `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` : "Downloading…") : appStatus.complete ? "Update app" : "Download app for offline"}
            </Button>
          </div>
        </div>
        {busy === "app" && progress && (
          <div className="h-1.5 overflow-hidden rounded-pill bg-veil/10" role="progressbar" aria-valuenow={Math.round((progress.done / Math.max(1, progress.total)) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-pill bg-gradient-to-r from-yang to-yin transition-[width] duration-200" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        )}
      </Card>

      {failed && (
        <ErrorNote>
          {online
            ? "Couldn't load the download catalogue — language packs and the database are unavailable for the moment. Everything already on this device still works."
            : "You're offline, so new language packs and the database can't be listed. Everything already saved on this device — the app, your languages, your media — works normally."}
        </ErrorNote>
      )}

      {/* Step 1 — Website language */}
      {manifest && (
      <section className="space-y-3">
        <h2 className="text-[18px] font-bold">1 · Website language</h2>
        <p className="text-[14px] text-ink-2">Download a language pack so the whole interface reads in your language offline.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Language">
            <select value={siteLang} onChange={(e) => setSiteLang(e.target.value)}
              className="h-10 min-w-[220px] rounded-field border border-line bg-space-2 px-3 text-[14px] font-normal text-ink">
              {manifest.languages.filter((l) => l.code !== "en").map((l) => (
                <option key={l.code} value={l.code}>{l.native} ({l.name}){l.strings ? ` · ${l.strings.toLocaleString()} strings` : ""}</option>
              ))}
            </select>
          </Field>
          <Button onClick={() => run("lang", async () => {
            await downloadLangPack(siteLang, langName(siteLang), (p) => setProgress(p));
            setMsg(`Saved the ${langName(siteLang)} language pack.`);
          })} disabled={!!busy || !online}>
            {busy === "lang" ? "Downloading…" : "Download language"}
          </Button>
        </div>
        {savedLangs.length > 0 && (
          <ul className="flex flex-wrap gap-2 pt-1">
            {savedLangs.map((l) => (
              <li key={l.lang} className="flex items-center gap-2 rounded-pill border border-line bg-space-2 py-1 pe-1 ps-3 text-[13px]">
                <span>{l.native} · {l.count.toLocaleString()}</span>
                <button type="button" aria-label={`Remove ${l.native}`} onClick={() => run("rm", () => removeLangPack(l.lang))}
                  className="grid h-6 w-6 place-items-center rounded-full text-ink-3 hover:bg-veil/10 hover:text-ink">×</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {/* Step 2 — Media. Saving happens where the media IS (a "Save offline" button on every
          Library item and on each file of a work), not here: a second download button on a page
          the member has to find first is a worse route to the same store. This states where the
          files land, and answers the screen-off question directly. */}
      <section className="space-y-3">
        <h2 className="text-[18px] font-bold">2 · Music, video, books and papers</h2>
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold">
                {media.n > 0
                  ? `${media.n} item${media.n === 1 ? "" : "s"} saved on this device · ${fmtBytes(media.bytes)}`
                  : "Nothing saved on this device yet"}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
                Open anything in the <strong className="font-semibold text-ink-2">Library</strong> — or any file on a published work — and press <strong className="font-semibold text-ink-2">Save offline</strong>. It downloads into this device and appears in <strong className="font-semibold text-ink-2">My Library</strong>, playable with no connection at all.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" href="/library/">Browse the Library</Button>
              <Button href="/my-library/">My Library</Button>
            </div>
          </div>
          <p className="rounded-card border border-line bg-space-2/40 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-3">
            🎧 <strong className="font-semibold text-ink-2">Music keeps playing when you lock your phone.</strong> Start a track in My Library, put the phone in your pocket and go for your run — the track, artist and cover show on the lock screen, and the play, pause and skip buttons there work. Nothing needs to stay open, and no signal is used.
            {/* The count is composed per member, so it is skip-marked: unmarked, the i18n walker
                harvests one row per distinct count per language into the PUBLIC aq_translations
                table, and saving one more track mints another and re-blocks first paint. */}
            {media.playable > 0 && (
              <span data-ay-skip="1">
                {` You have ${media.playable} track${media.playable === 1 ? "" : "s"} ready to play right now.`}
              </span>
            )}
          </p>
        </Card>
      </section>

      {/* Step 3 — Everything else (full public database) */}
      {manifest && (
      <section className="space-y-3">
        <h2 className="text-[18px] font-bold">3 · Everything else</h2>
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">Full public database</p>
            <p className="text-[13px] text-ink-3">
              Every table and row — all members, activity, coins, donations and rankings (radical transparency).
              {/* Before the download the row count is the database engine's own estimate, so it is
                  marked approximate; after it, savedDb.rows is a true count of what was written.
                  Without the tilde the figure changes on download and reads as a bug. */}
              {savedDb ? ` Saved: ${savedDb.tables} tables · ${savedDb.rows.toLocaleString()} rows.` : ` ${manifest.tables.length} tables · ~${manifest.tables.reduce((a, t) => a + t.rows, 0).toLocaleString()} rows.`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedDb && <LinkButton onClick={() => run("rm", removeDatabase)}>Remove</LinkButton>}
            <Button variant="outline" disabled={!!busy || !online}
              onClick={() => run("db", async () => { await downloadDatabase((p) => setProgress(p)); setMsg("Saved the full public database."); })}>
              {busy === "db" ? (progress?.phase || "Downloading…") : savedDb ? "Update" : "Download database"}
            </Button>
          </div>
        </Card>
        {busy === "db" && progress && (
          <p role="status" className="text-[13px] text-ink-3">{progress.phase} ({progress.done}/{progress.total})</p>
        )}
      </section>
      )}

      {msg &&<p role="status" className="rounded-card border border-yang/40 bg-yang/10 px-4 py-3 text-[14px] text-yang">{msg}</p>}

      {/* Manage. "Remove all downloads" clears the offline store (app files, languages, database) —
          it deliberately does NOT touch the member's device media, which they saved deliberately
          one file at a time and remove the same way in My Library. */}
      {(savedLangs.length > 0 || savedDb || appStatus.complete) && (
        <section className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
          <p className="text-[13px] text-ink-3">
            {savedLangs.length} language{savedLangs.length === 1 ? "" : "s"}{savedDb ? ", full database" : ""}{appStatus.complete ? ", the app" : ""} saved · {fmtBytes(usage.usage)} used
          </p>
          <Button variant="ghost" disabled={!!busy} onClick={() => run("clear", async () => { await clearAll(); setMsg("Removed all offline downloads. Your saved media in My Library is untouched."); })}>
            Remove all downloads
          </Button>
        </section>
      )}
    </div>
  );
}
