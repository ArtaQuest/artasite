/**
 * @arta helpers that are not components (components/arta.tsx draws them): the avatar URL, mention
 * detection, the bug: prefix, which attachments are Arta's own files, and the live-status hook.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import artaAvatarUrl from "../assets/arta-thinking.svg";
import { artaWatch, ARTA_HANDLE, type ArtaWatch, type ArtaMentionState, type LibraryItem } from "./api";

/** Arta's avatar: upper-body crop of artalife's official think() pose. Same file the server
 *  hands out (wp-content/plugins/aquest/assets/arta/arta-thinking.svg) — keep the two identical. */
export const ARTA_AVATAR = artaAvatarUrl;

export function isArta(a: { slug?: string; bot?: boolean } | null | undefined): boolean {
  return !!a && (!!a.bot || a.slug === ARTA_HANDLE || a.slug === "artabot");
}


// Mirrors Arta::extract_handles on the server (src/Arta.php): an @ that is not glued to a word, an
// email or a path, then a 3-30 char handle. A capture group instead of a lookbehind so older Safari
// parses it.
export const MENTION_RE = /(^|[^A-Za-z0-9_@./+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,28}[A-Za-z0-9])?)(?![A-Za-z0-9_-]|@|\.[A-Za-z0-9])/g;
const ARTA_RE = /(^|[^A-Za-z0-9_@./+-])@(arta|artabot)(?![A-Za-z0-9_-]|@|\.[A-Za-z0-9])/i;
export function mentionsArta(text: string): boolean { return ARTA_RE.test(text || ""); }
/** The same "bug:" prefix Arta::is_bug_prefix recognises (after an optional greeting + mention). */
export function looksLikeBug(text: string): boolean {
  return /^\s*(?:(?:hey|hi|hello)[\s,]+)?(?:@\w[\w-]*[\s,:]+)*(?:bug\s*:|\[bug\]|#bug\b)/i.test(text || "");
}


/** A file Arta attached (stored in aq_arta_files; the server hands them out with negative ids and no
 *  `work`, unlike Library attachments, which always carry the work they came from). */
export function isArtaFile(it: LibraryItem): boolean { return it.id < 0 || !it.work; }


/** A real photo the brain found and attached (photo.jpg / photo-bw.jpg), drawn as a captioned figure. */
export function isArtaPhoto(it: { name: string }): boolean { return /^photo(-bw)?(-\d+)?\.jpe?g$/i.test(it.name); }

/** The photo credit the brain appends to a reply ("📷 [author, license](file page)"), split off so
 *  it can be drawn as the photo's caption instead of trailing the text. Safe hrefs only. */
const CREDIT_RE = /\s*📷\s*\[([^\]\n]{1,200})\]\((https:\/\/[^)\s]{1,500})\)\s*/u;
export function splitPhotoCredit(body: string): { text: string; credit: { label: string; href: string } | null } {
  const m = CREDIT_RE.exec(body || "");
  const href = m && /^https:\/\/[^\s<>"']+$/i.test(m[2]) ? m[2] : null;
  if (!m || !href) return { text: body, credit: null };
  return { text: (body.slice(0, m.index) + " " + body.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim(), credit: { label: m[1], href } };
}


const OPEN = new Set<ArtaMentionState["status"]>(["queued", "working", "replying"]);

/**
 * Polls GET arta/watch/{postId} while `active` and something in the thread is still open. Backoff:
 * 4s → ×1.4 per round, capped at 30s; 60s while Arta is offline or paused; paused while the tab is
 * hidden; gives up after 30 minutes (a reload starts it again). `onReplied` fires with the mention
 * post ids whose answers landed since the first look — the caller reloads the thread.
 */
export function useArtaWatch(postId: number, active: boolean, onReplied?: (ids: number[]) => void) {
  const [data, setData] = useState<ArtaWatch | null>(null);
  const [round, setRound] = useState(0);
  const seen = useRef<Set<number> | null>(null);
  const cb = useRef(onReplied);
  useEffect(() => { cb.current = onReplied; }, [onReplied]);
  useEffect(() => {
    if (!active || !postId) return;
    let stop = false, timer = 0, delay = 4000;
    const t0 = Date.now();
    const again = (ms: number) => { timer = window.setTimeout(run, ms); };
    function run() {
      if (stop) return;
      if (document.hidden) { again(5000); return; }
      artaWatch(postId).then((w) => {
        if (stop) return;
        setData(w);
        const replied = w.items.filter((i) => i.status === "replied").map((i) => i.post_id);
        if (seen.current) {
          const fresh = replied.filter((id) => !seen.current!.has(id));
          if (fresh.length) cb.current?.(fresh);
        }
        seen.current = new Set([...(seen.current || []), ...replied]);
        if (!w.items.some((i) => OPEN.has(i.status)) || Date.now() - t0 > 30 * 60_000) return;
        const away = !w.enabled || !w.online || w.paused_until * 1000 > Date.now();
        delay = away ? 60_000 : Math.min(30_000, Math.round(delay * 1.4));
        again(delay);
      }).catch(() => { if (!stop) { delay = Math.min(60_000, delay * 2); again(delay); } });
    }
    run();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [postId, active, round]);
  /** Look again now (a new @arta reply was just posted in the thread). */
  const kick = useCallback(() => setRound((n) => n + 1), []);
  return { data, kick };
}

export type ArtaPillState =
  | { kind: "thinking" } | { kind: "queued"; position: number } | { kind: "offline" } | { kind: "paused" }
  | { kind: "limited" } | { kind: "missed" } | { kind: "replied" } | null;

/** The one thing worth saying about a thread's mentions right now (earliest open one wins). */
export function pillState(w: ArtaWatch | null, only?: (s: ArtaMentionState) => boolean): ArtaPillState {
  if (!w) return null;
  const items = only ? w.items.filter(only) : w.items;
  if (!items.length) return null;
  const open = items.filter((i) => OPEN.has(i.status));
  if (open.length) {
    if (open.some((i) => i.status !== "queued")) return { kind: "thinking" };
    if (!w.enabled || !w.online) return { kind: "offline" };
    if (w.paused_until > 0) return { kind: "paused" }; // the server sends 0 once a pause is over
    return { kind: "queued", position: Math.max(1, Math.min(...open.map((i) => i.position || 1))) };
  }
  const last = items[items.length - 1];
  if (last.status === "limited") return { kind: "limited" };
  if (last.status === "expired" || last.status === "failed") return { kind: "missed" };
  if (items.some((i) => i.status === "replied")) return { kind: "replied" };
  return null;
}

