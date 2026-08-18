// My Library — the member's own music, videos and documents, consumed like YouTube Music but 100%
// ON THIS DEVICE (operator, 2026-07-25): import MP3/MP4/PDF → bytes live in IndexedDB on this
// device, playable OFFLINE, in a pocket, through headphones (Media Session lock-screen
// controls). Music gets a queue + shuffle/repeat + persistent mini-player; videos a lightbox with
// PiP; PDFs open in the ArtaRead BOOK. Sharing hands the actual file to other apps via the system
// share sheet (AirDrop/WhatsApp/…) — nothing ever uploads to a server. (Distinct from /library,
// the platform's published-works Library.)
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { importFiles, listItems, removeItem, shareItem, storageEstimate, getFile, coverUrl, reconcile, isPersisted, continueList, type Progress, type MediaItem, type MediaKind } from "../lib/media-store";
import { usePlayer, usePlayerCtx, VideoLightbox, PlayerBar as PlayerBarFallback } from "../components/player";
import { BookReader } from "../components/book";
import { ConfirmDialog } from "../components/ui";
import { openPdf, type PdfBook } from "../lib/pdf-extract";
import { cloudList, cloudUpload, cloudDelete, cloudBuy, type CloudItem, type CloudQuota } from "../lib/api";
import { isLoggedIn } from "../lib/wp";

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fmtDur = (s?: number) => {
  if (!s || !isFinite(s)) return "";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

const KIND_LABEL: Record<MediaKind, string> = { music: "Music", video: "Videos", doc: "Documents" };

export default function MyLibrary() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<MediaKind | "all">("all");
  const [busy, setBusy] = useState<{ i: number; n: number; name: string } | null>(null);
  const [store, setStore] = useState<{ used: number; quota: number } | null>(null);
  const [video, setVideo] = useState<MediaItem | null>(null);
  const [book, setBook] = useState<PdfBook | null>(null);
  const [bookBusy, setBookBusy] = useState(false);
  const [note, setNote] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Prefer the APP-WIDE player (mounted in AppShell) so playback survives leaving this page;
  // the local instance is only a fallback if the provider is ever absent.
  const localPlayer = usePlayer();
  const shared = usePlayerCtx();
  const player = shared ?? localPlayer;
  // ── the OPTIONAL cloud shelf. Publishing is opt-in per file and is explained before it happens.
  const [cloud, setCloud] = useState<CloudItem[]>([]);
  const [quota, setQuota] = useState<CloudQuota | null>(null);
  const [pub, setPub] = useState<{ id: string; frac: number } | null>(null);
  const [cont, setCont] = useState<Progress[]>([]);

  useEffect(() => { document.title = "My Library — your music, videos and documents · ArtaQuest"; }, []);
  const [durable, setDurable] = useState(true);
  const refresh = useCallback(async () => {
    setItems(await listItems());
    setStore(await storageEstimate());
  }, []);
  const refreshCloud = useCallback(async () => {
    if (!isLoggedIn()) return;
    try { const r = await cloudList(); setCloud(r.items); setQuota(r.quota); } catch { /* offline or signed out — the device library still works */ }
  }, []);
  useEffect(() => {
    void (async () => {
      await reconcile();                     // heal rows whose bytes were evicted, drop orphan blobs
      await refresh();
      setDurable(await isPersisted());
      await refreshCloud();
      setCont(await continueList());
    })();
  }, [refresh, refreshCloud]);

  const doImport = useCallback(async (files: FileList | File[] | null | undefined) => {
    const list = [...(files || [])];
    if (!list.length) return;
    setBusy({ i: 0, n: list.length, name: "" });
    try {
      const { added, failed } = await importFiles(list, (i, n, name) => setBusy({ i, n, name }));
      const ok = added.length ? `Added ${added.length} ${added.length === 1 ? "item" : "items"}.` : "";
      const bad = failed.length ? `${failed.length} couldn't be added — ${failed.slice(0, 2).map((f) => `${f.name} (${f.reason})`).join("; ")}${failed.length > 2 ? "…" : ""}` : "";
      setNote([ok, bad].filter(Boolean).join(" ") || "Nothing to add — bring MP3/M4A music, MP4/WebM video, or PDF documents.");
    } catch (e) {
      setNote("Could not import — " + (e instanceof Error ? e.message : "your device may be out of space."));
    } finally {
      setBusy(null);
      await refresh();                       // a partly successful batch must still appear
      window.setTimeout(() => setNote(""), 8000);
    }
  }, [refresh]);

  // A device file counts as published when the shelf holds one with the same name and size.
  const publishedKeys = useMemo(() => new Set(cloud.map((c) => `${c.name}:${c.bytes}`)), [cloud]);
  const isPublished = useCallback((it: MediaItem) => publishedKeys.has(`${it.name}:${it.size}`), [publishedKeys]);
  const music = useMemo(() => items.filter((x) => x.kind === "music"), [items]);
  const shown = useMemo(() => {
    const base = tab === "all" ? items : items.filter((x) => x.kind === tab);
    const needle = q.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((x) => `${x.title} ${x.artist || ""} ${x.album || ""} ${x.name}`.toLowerCase().includes(needle));
  }, [items, tab, q]);

  const open = useCallback(async (item: MediaItem) => {
    if (item.kind === "music") {
      const list = shown.filter((x) => x.kind === "music");
      void player.playAt(list.length ? list : [item], Math.max(0, list.findIndex((x) => x.id === item.id)));
    } else if (item.kind === "video") {
      setVideo(item);
    } else {
      setBookBusy(true);
      try {
        setBook(await openPdf(await getFile(item)));
      } catch { setNote("Could not open this PDF."); window.setTimeout(() => setNote(""), 4000); }
      finally { setBookBusy(false); }
    }
  }, [shown, player]);

  /** Copy one device file up to the member's PUBLIC shelf. The confirm is deliberate: this is the
   *  moment a private file stops being private, and it must never happen by a mis-tap. */
  /**
   * THE CONFIRMATION, IN OUR SURFACE (ui.tsx ConfirmDialog) rather than the browser's. All three
   * were window.confirm, and the publish one matters most: it is the moment a private file stops
   * being private, and Safari draws a native confirm as a strip that truncates exactly the sentence
   * saying so.
   *
   * A pending ACTION, not a pending id: each of these is an async callback carrying its own closure,
   * so the dialog holds the words to show and the thing to run. Sharing one boolean between three
   * confirmations is how the wrong one fires.
   */
  const [pending, setPending] = useState<{ title: string; body: ReactNode; label: string; danger: boolean; run: () => void } | null>(null);

  const doPublish = useCallback(async (item: MediaItem) => {
    setPub({ id: item.id, frac: 0 });
    try {
      const file = await getFile(item);
      await cloudUpload(file, { title: item.title, artist: item.artist, album: item.album, duration: item.duration },
        (frac) => setPub({ id: item.id, frac }));
      await refreshCloud();
      setNote(`“${item.title}” is on your cloud shelf.`);
    } catch (e) {
      setNote("Could not publish — " + (e instanceof Error ? e.message : "try again."));
    } finally { setPub(null); window.setTimeout(() => setNote(""), 6000); }
  }, [refreshCloud]);

  const doUnpublish = useCallback(async (c: CloudItem) => {
    try { const r = await cloudDelete(c.id); setQuota(r.quota); await refreshCloud(); setNote("Removed from your cloud shelf."); }
    catch { setNote("Could not remove it — try again."); }
    window.setTimeout(() => setNote(""), 5000);
  }, [refreshCloud]);

  const buyCapacity = useCallback(async () => {
    const per = quota ? Math.round(quota.bytes_per_coin / 1e6) : 100;
    // Same rule as the wallet: state a balance only when we HAVE one. `quota?.balance ?? 0` told a
    // member "You have ₳0" whenever the quota fetch had not answered — a claim about their money,
    // made from a fetch that failed, in a modal they cannot inspect.
    const have = quota ? `You have ₳${quota.balance}.` : "";
    const raw = window.prompt(`How many Arta Coin would you like to spend?\n\nEach coin adds ${per} MB of permanent shelf space.${have ? " " + have : ""}`, "1");
    const coins = Number(raw);
    if (!raw || !Number.isFinite(coins) || coins < 1) return;
    try { const r = await cloudBuy(Math.floor(coins)); setNote(`Added ${fmtSize(r.bytes)}. Balance ₳${r.balance}.`); await refreshCloud(); }
    catch (e) { setNote("Could not buy space — " + (e instanceof Error ? e.message : "try again.")); }
    window.setTimeout(() => setNote(""), 6000);
  }, [quota, refreshCloud]);

  /** Copy the public link of a published item — the shareable half of the cloud shelf. */
  const copyLink = useCallback(async (c: CloudItem) => {
    try { await navigator.clipboard.writeText(c.url); setNote("Public link copied."); }
    catch { setNote(c.url); }
    window.setTimeout(() => setNote(""), 5000);
  }, []);

  const share = useCallback(async (item: MediaItem) => {
    const r = await shareItem(item);
    setNote(r === "shared" ? "Shared." : r === "saved" ? "Saved to your downloads." : "Sharing isn't available here.");
    window.setTimeout(() => setNote(""), 4000);
  }, []);

  const doDelete = useCallback(async (item: MediaItem) => {
    if (player.state.current?.id === item.id) player.stop();
    await removeItem(item);
    await refresh();
  }, [player, refresh]);

  const publish = useCallback((item: MediaItem) => {
    if (!isLoggedIn()) { setNote("Sign in to use your cloud shelf."); window.setTimeout(() => setNote(""), 5000); return; }
    setPending({
      title: "Publish to your cloud shelf?",
      label: "Publish",
      danger: false,
      body: <><p><span data-ay-skip="1" className="font-semibold text-ink">{item.title}</span> becomes PUBLIC — anyone with the link can play or download it, and it appears on your Library page.</p><p className="text-ink-3">Files you keep on this device stay private.</p></>,
      run: () => { void doPublish(item); },
    });
  }, [doPublish]);

  const unpublish = useCallback((c: CloudItem) => {
    setPending({
      title: "Remove from your cloud shelf?",
      label: "Remove",
      danger: true,
      body: <><p><span data-ay-skip="1" className="font-semibold text-ink">{c.title}</span> stops being public and its link stops working.</p><p className="text-ink-3">Your copy on this device is untouched.</p></>,
      run: () => { void doUnpublish(c); },
    });
  }, [doUnpublish]);

  const del = useCallback((item: MediaItem) => {
    setPending({
      title: "Remove from this device?",
      label: "Remove",
      danger: true,
      body: <p>The file for <span data-ay-skip="1" className="font-semibold text-ink">{item.title}</span> is deleted from this device. Anything on your cloud shelf stays there.</p>,
      run: () => { void doDelete(item); },
    });
  }, [doDelete]);

  if (book) return <BookReader book={book} onClose={() => setBook(null)} />;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-8" onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void doImport(e.dataTransfer.files); }}>
      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ""}
        body={pending?.body}
        confirmLabel={pending?.label ?? "Confirm"}
        danger={pending?.danger ?? true}
        onCancel={() => setPending(null)}
        onConfirm={() => { const p = pending; setPending(null); p?.run(); }}
      />
      <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">My Library</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="mt-1 text-[26px] font-extrabold text-ink">Your music, videos and documents</h1>
        <button type="button" className="aq-lib-add" onClick={() => fileRef.current?.click()}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          Add files
        </button>
      </div>
      <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-2">
        Everything lives <strong>on this device</strong> and never uploads — it plays offline, in your pocket,
        through your headphones with lock-screen controls. Share hands the actual file to your other apps.
      </p>
      <input ref={fileRef} type="file" multiple accept="audio/*,video/*,application/pdf,.mp3,.m4a,.flac,.ogg,.wav,.mp4,.m4v,.webm,.pdf" className="hidden"
        onChange={(e) => { void doImport(e.target.files); e.currentTarget.value = ""; }} />

      {/* import progress + notices + storage meter */}
      {busy && (
        <div className="aq-lib-busy" role="status">
          <span className="aq-book-spinner aq-book-spinner-sm" aria-hidden />
          Importing {Math.min(busy.i + 1, busy.n)} of {busy.n}<span data-ay-skip="1">{busy.name ? ` — ${busy.name}` : ""}</span>…
          <span className="aq-book-load-bar"><span style={{ width: `${Math.round((busy.i / Math.max(1, busy.n)) * 100)}%` }} /></span>
        </div>
      )}
      {note && <p className="mt-3 text-[13.5px] text-ink-2" role="status">{note}</p>}
      {store && store.quota > 0 && (
        <p className="mt-2 text-[12px] tabular-nums text-ink-3">
          {fmtSize(store.used)} used of {fmtSize(store.quota)} available on this device
          {!durable && <span className="text-ink-3"> · your browser may clear this if space runs low</span>}
        </p>
      )}
      {quota && (
        <div className="aq-lib-cloud">
          <span className="aq-lib-cloud-head">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6.5 19z" /></svg>
            Cloud shelf
          </span>
          <span className="aq-lib-cloud-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, Math.round((quota.used / Math.max(1, quota.capacity)) * 100))}%` }} />
          </span>
          <span className="aq-lib-cloud-num">{fmtSize(quota.used)} of {fmtSize(quota.capacity)}</span>
          <button type="button" className="aq-lib-tab" onClick={() => void buyCapacity()}>
            Add space · ₳1 = {fmtSize(quota.bytes_per_coin)}
          </button>
        </div>
      )}
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
        Your cloud shelf is <strong>public</strong> — anything you put there can be played or downloaded by
        anyone with the link, and shows on your Library page. Keep a file on this device to keep it private.
      </p>

      {/* Continue — the shelf that makes a long listen or a long read worth starting on a phone. */}
      {cont.length > 0 && (() => {
        const rows = cont.map((p) => ({ p, item: items.find((i) => i.id === p.id) })).filter((r) => r.item);
        if (!rows.length) return null;
        return (
          <section className="aq-lib-cont" aria-label="Continue">
            <h2 className="aq-lib-cont-h">Continue</h2>
            <ul className="aq-lib-cont-row" role="list">
              {rows.map(({ p, item }) => (
                <li key={p.id}>
                  <button type="button" className="aq-lib-cont-card" onClick={() => void open(item!)}
                    aria-label={item!.kind === "music" ? "Continue this track" : item!.kind === "video" ? "Continue this video" : "Continue reading"}>
                    <LibCover item={item!} />
                    <span className="aq-lib-cont-meta" data-ay-skip="1">
                      <span className="aq-lib-title">{item!.title}</span>
                      <span className="aq-lib-sub">{Math.round(p.pct * 100)}% · {fmtDur(Math.max(0, p.dur - p.pos))} left</span>
                    </span>
                    <span className="aq-lib-cont-bar" aria-hidden><span style={{ width: `${Math.round(p.pct * 100)}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      {/* tabs + search + shuffle-all */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(["all", "music", "video", "doc"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`aq-lib-tab${tab === t ? " aq-lib-tab-on" : ""}`} aria-pressed={tab === t}>
            {t === "all" ? "Everything" : KIND_LABEL[t]}
            <span className="aq-lib-count">{t === "all" ? items.length : items.filter((x) => x.kind === t).length}</span>
          </button>
        ))}
        <span className="mx-1 grow" />
        {music.length > 0 && (
          <button type="button" className="aq-lib-tab" onClick={() => { player.setShuffle(true); void player.playAt(music, Math.floor(Math.random() * music.length)); }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
            Shuffle all
          </button>
        )}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library" aria-label="Search your library" className="aq-lib-search" />
      </div>

      {/* the shelf */}
      {shown.length === 0 ? (
        <div className={`aq-lib-empty${drag ? " aq-lib-drag" : ""}`} role="button" tabIndex={0} aria-label="Add files to your library"
          onClick={() => fileRef.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-3"><path d="M9 18V6l12-3v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-3a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" /></svg>
          <p className="text-[14.5px] font-semibold text-ink">{items.length ? "Nothing matches your search" : "Drop MP3s, MP4s and PDFs here"}</p>
          <p className="text-[12.5px] text-ink-3">{items.length ? "Try another search or tab." : "Or tap to choose files — they stay on this device."}</p>
        </div>
      ) : null}
      {/* The other way in, and the less obvious one: media published on the platform can be pulled
          onto this device from the Library with "Save offline". Outside the drop zone above, which
          is itself a button — a link nested in a button is invalid and steals the click. */}
      {shown.length === 0 && items.length === 0 ? (
        <p className="mt-3 text-center text-[12.5px] text-ink-3">
          Or open the <a href="/library/" className="font-semibold text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Library</a> and press <strong className="font-semibold text-ink-2">Save offline</strong> on any track, video or paper.
        </p>
      ) : null}
      {shown.length > 0 && (
        <ul className="aq-lib-grid" role="list">
          {shown.map((item) => (
            <li key={item.id} className="aq-lib-item">
              <button type="button" className="aq-lib-open" onClick={() => void open(item)}
                aria-label={item.kind === "music" ? "Play this track" : item.kind === "video" ? "Play this video" : "Read this document"}>
                <LibCover item={item} />
                <span className="aq-lib-hover" aria-hidden>
                  {item.kind === "doc"
                    ? <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                    : <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
                </span>
                <span className="aq-lib-meta" data-ay-skip="1">
                  <span className="aq-lib-title">{item.title}</span>
                  <span className="aq-lib-sub">
                    {item.kind === "music" ? (item.artist || "Music") : item.kind === "video" ? "Video" : "PDF"}
                    {item.duration ? ` · ${fmtDur(item.duration)}` : ""} · {fmtSize(item.size)}
                  </span>
                </span>
              </button>
              <span className="aq-lib-acts">
                {pub?.id === item.id ? (
                  <span className="aq-lib-act aq-lib-upfrac" title="Publishing">{Math.round(pub.frac * 100)}%</span>
                ) : isPublished(item) ? (
                  <button type="button" className="aq-lib-act aq-lib-act-on" aria-label="Copy public link"
                    title="Public — click to copy its link (shift-click to unpublish)"
                    onClick={(e) => { const c = cloud.find((x) => x.name === item.name && x.bytes === item.size); if (!c) return; if (e.shiftKey) void unpublish(c); else void copyLink(c); }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6.5 19z" /><path d="M9 13l2 2 4-4" /></svg>
                  </button>
                ) : (
                  <button type="button" className="aq-lib-act" onClick={() => void publish(item)} aria-label="Publish to your cloud shelf" title="Publish to your cloud shelf (makes it public)">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.6-1.6A4 4 0 0 0 6.5 19z" /><path d="M12 16v-6M9.5 12.5 12 10l2.5 2.5" /></svg>
                  </button>
                )}
                <button type="button" className="aq-lib-act" onClick={() => void share(item)} aria-label="Share this item" title="Share">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.9 4M15.4 6.5l-6.8 4" /></svg>
                </button>
                <button type="button" className="aq-lib-act" onClick={() => void del(item)} aria-label="Remove from this device" title="Remove from this device">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {bookBusy && (
        <div className="aq-lib-busy" role="status"><span className="aq-book-spinner aq-book-spinner-sm" aria-hidden /> Opening your book…</div>
      )}

      {video && <VideoLightbox item={video} onClose={() => setVideo(null)} />}
      {!shared && <PlayerBarFallback p={player} />}
    </main>
  );
}

function LibCover({ item }: { item: MediaItem }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let ok = true;
    void coverUrl(item.id, item.hasCover).then((u) => { if (ok) setUrl(u); });
    return () => { ok = false; };
  }, [item.id, item.hasCover]);
  if (url) return <img src={url} alt="" className="aq-lib-art" loading="lazy" />;
  return (
    <span className={`aq-lib-art aq-lib-art-ph aq-lib-ph-${item.kind}`} aria-hidden>
      {item.kind === "music"
        ? <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z" /></svg>
        : item.kind === "video"
          ? <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
          : <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>}
    </span>
  );
}
