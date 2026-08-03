/**
 * ONE chat session, shared by every surface that shows it.
 *
 * ArtaChat now appears in two places at once: the dock that rides along on every page, and the
 * full /messages page. Each used to own its own bootstrap — device identity, key registration,
 * the conversation-list poller, the preview decryption cache — so having both mounted meant two
 * identities loaded, two key registrations, two pollers hitting `chat/list` every 15s, and every
 * preview decrypted twice. This module is the single owner of all of it.
 *
 * Shape: a module-level store with a subscriber set. The poller runs only while at least one
 * component is subscribed AND the tab is visible, so a collapsed dock on a page nobody is looking
 * at costs nothing. Identity is promise-cached, so N simultaneous callers share one boot.
 *
 * Everything here is on-device. The private key is non-extractable and never leaves the browser
 * (see lib/e2ee.ts); previews are decrypted here and handed to the UI as plain strings, which is
 * why every element that renders one must carry `data-ay-skip="1"` — the i18n mesh publishes any
 * string it can reach into the PUBLIC aq_translations table.
 */
import {
  chatList, chatRegisterKey, chatUnread,
  type ChatKey, type ChatListPage,
} from "./api";
import {
  decodePayload, deriveChatKey, e2eeSupported, ensureIdentity, importPeerPub, openMessage,
  type ChatPayload, type Identity,
} from "./e2ee";
import { isLoggedIn } from "./wp";

/** How often the conversation LIST refreshes while a surface is actually showing it. */
const POLL_MS = 15000;
/** How often the collapsed dock refreshes just its unread badge. Slower, and via a route that
 *  touches no presence — see the note on `watchList` below. */
const BADGE_MS = 60000;

export type ChatState = {
  identity: Identity | null;
  myKey: ChatKey | null;
  page: ChatListPage | null;
  /** chat id → decrypted one-line preview ("You: …" when it was ours). */
  previews: Record<number, string>;
  /** Total unread across every conversation — what the dock's badge shows. */
  unread: number;
  /** A hard failure that leaves messaging unusable (no WebCrypto, boot failed). */
  fatal: string | null;
  /** True once a conversation list has actually arrived — not merely once the key was registered. */
  ready: boolean;
  /** The list has never loaded and the last attempt failed (offline, timeout, 5xx). */
  listError: boolean;
};

let state: ChatState = {
  identity: null, myKey: null, page: null, previews: {}, unread: 0, fatal: null, ready: false, listError: false,
};

const subs = new Set<() => void>();
function emit() {
  // A fresh object each time so useSyncExternalStore/useState consumers see a new reference.
  for (const fn of subs) fn();
}
function set(patch: Partial<ChatState>) {
  state = { ...state, ...patch };
  emit();
}

export function getChatState(): ChatState {
  return state;
}

// ── boot (once) ──────────────────────────────────────────────────────────────

let bootPromise: Promise<void> | null = null;

/**
 * Load this device's identity and PUBLISH its public half.
 *
 * Deliberately NOT called just because the dock is on screen. Registering a public key is a
 * consequential act: the server treats a new key as a rotation, and every message sealed to the
 * previous one becomes unopenable to this member forever. Before the dock, that only happened when
 * someone opened Messages. If merely rendering a badge did it, then reading the feed in a private
 * window — or on a colleague's browser, or after clearing site data — would silently retire the
 * member's real device key and strand their history.
 *
 * So this runs only when a surface genuinely needs to DECRYPT something: watchList() (the
 * conversation list, which shows decrypted previews) or opening a thread. The badge needs no
 * identity at all — it is a count from the server.
 */
export function bootChat(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (!isLoggedIn()) return;
    if (!e2eeSupported()) {
      set({ fatal: "This browser can’t run the encryption (WebCrypto unavailable). Try a current browser over HTTPS." });
      return;
    }
    try {
      const identity = await ensureIdentity();
      const reg = await chatRegisterKey(identity.pubB64);
      set({ identity, myKey: reg.key }); // `ready` waits for the first list — see refresh()
      await refresh(true);
    } catch {
      set({ fatal: "Couldn’t set up encrypted messaging — refresh to try again." });
      bootPromise = null; // retryable: a transient failure must not disable messaging for the visit
    }
  })();
  return bootPromise;
}

// ── the conversation list + decrypted previews ───────────────────────────────

/** Derived conversation keys, cached per (akid,bkid) epoch so a refresh re-derives nothing. */
const keyCache = new Map<string, CryptoKey>();
/** chat id → the message id its cached preview was decrypted from, so an unchanged
 *  conversation is never decrypted twice. */
const previewFor = new Map<number, number>();

let refreshing = false;
let lastRefresh = 0;
/** Below this age a list is treated as still fresh. Flipping between the dock's conversation list
 *  and a thread would otherwise re-fetch (and re-mark presence) on every switch. */
const FRESH_MS = 5000;

/** Pull the conversation list and decrypt any preview that actually changed. */
export async function refresh(force = false): Promise<void> {
  if (refreshing || !state.myKey) return;
  if (!force && state.page && Date.now() - lastRefresh < FRESH_MS) return;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    // A deadline, because the latch above is single-flight: without one, a request that never
    // settles (a dead socket, a proxy holding the connection) would leave `refreshing` true and
    // the conversation list frozen for the rest of the visit, with nothing on screen saying so.
    const page = await Promise.race([
      chatList(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
    const previews: Record<number, string> = {};
    const identity = state.identity;
    const myKid = state.myKey?.kid;
    for (const c of page.items) {
      const m = c.last;
      if (!m || !identity || myKid === undefined) continue;
      // Unchanged conversation → keep the preview we already decrypted.
      if (previewFor.get(c.id) === m.id && state.previews[c.id] !== undefined) {
        previews[c.id] = state.previews[c.id];
        continue;
      }
      const mine = page.me === c.low_uid;
      const mineKid = mine ? m.akid : m.bkid;
      const peerPub = page.keys[mine ? m.bkid : m.akid]?.pub;
      if (mineKid !== myKid || !peerPub) continue; // sealed to a retired device key
      const low = Math.min(page.me, c.peer.id);
      const high = Math.max(page.me, c.peer.id);
      const ck = `${m.akid}:${m.bkid}`;
      try {
        let key = keyCache.get(ck);
        if (!key) {
          key = await deriveChatKey(identity.priv, await importPeerPub(peerPub), low, high, m.akid, m.bkid);
          keyCache.set(ck, key);
        }
        const plain = await openMessage(key, m.iv, m.ct, low, high, m.sender);
        if (plain !== null) {
          const line = previewOf(decodePayload(plain));
          if (line) {
            previews[c.id] = m.sender === page.me ? `You: ${line}` : line;
            previewFor.set(c.id, m.id);
          }
        }
      } catch { /* unopenable row — the list just shows its timestamp */ }
    }
    const unread = page.items.reduce((n, c) => n + (c.unread || 0), 0);
    // `ready` only becomes true once a list has actually arrived — flipping it at boot meant a
    // failed first load rendered as a confident "no conversations yet".
    set({ page, previews, unread, ready: true, listError: false });
  } catch {
    // Keep the last good list, but say so when there has never been one.
    if (!state.page) set({ listError: true });
  }
  finally { refreshing = false; }
}

/** One line describing a decrypted payload — the summary every messenger's list is made of. */
export function previewOf(p: ChatPayload): string {
  switch (p.t) {
    case "text": return p.body;
    case "img": return p.body ? `📷 ${p.body}` : "📷 Photo";
    case "voice": return "🎤 Voice message";
    case "file":
      return p.att.mime.startsWith("video/") ? "🎬 Video"
        : p.att.mime.startsWith("audio/") ? "🎵 Audio"
        : `📎 ${p.att.name || "File"}`;
    case "react": return `Reacted ${p.emoji}`;
    case "edit": return p.body;
    case "del": return "Message removed";
    default: return "";
  }
}

/** Locally zero a conversation's unread count the moment it's opened, so the badge responds
 *  immediately instead of waiting for the next poll to confirm what we already know. */
export function markSeen(chatId: number): void {
  const page = state.page;
  if (!page) return;
  const items = page.items.map((c) => (c.id === chatId ? { ...c, unread: 0 } : c));
  if (items.every((c, i) => c === page.items[i])) return;
  set({ page: { ...page, items }, unread: items.reduce((n, c) => n + (c.unread || 0), 0) });
}

// ── the shared pollers ───────────────────────────────────────────────────────
//
// TWO cadences, and the split is a correctness requirement rather than a tuning choice.
//
// Reading the conversation LIST is a real "I am in Messages" signal, and the server treats it as
// one — Chat::messages/typing mark presence, and Chat::send skips the bell and the away-email for a
// peer who is present. So the list may only be polled while a surface is genuinely SHOWING it. The
// dock rides along on every page; if it polled the list from the corner of an unrelated page, the
// member would look permanently online and would stop being told about their own messages.
//
// The collapsed dock therefore polls `chat/unread` instead: one count, no presence, once a minute.
// Both pollers are reference-counted and stop with the last watcher, and neither runs on a hidden
// tab. Requests are shared: the dock and the full page together produce ONE stream.

let listTimer: ReturnType<typeof setInterval> | undefined;
let badgeTimer: ReturnType<typeof setInterval> | undefined;
let subscribers = 0;   // anyone at all (drives the badge)
let listWatchers = 0;  // surfaces actually rendering the conversation list

/** Refresh only the unread badge — no presence, no ciphertext, no decryption. */
async function refreshBadge(): Promise<void> {
  if (!isLoggedIn()) return; // no identity needed: this is a server-side count, not a decryption
  try {
    const { unread } = await chatUnread();
    if (unread !== state.unread) set({ unread });
  } catch { /* transient — keep the last count */ }
}

function sync() {
  const hidden = typeof document !== "undefined" && document.hidden;
  // List poller: only while a surface shows the list.
  if (!hidden && listWatchers > 0 && !listTimer) {
    listTimer = setInterval(() => { void refresh(true); }, POLL_MS);
  } else if ((hidden || listWatchers === 0) && listTimer) {
    clearInterval(listTimer); listTimer = undefined;
  }
  // Badge poller: whenever anyone is subscribed but nobody is showing the list (otherwise the
  // list refresh already carries a fresh count, and a second request would be waste).
  // Logged-out visitors subscribe too (the bottom-tab hook runs before its own visitor check), so
  // gate the timer rather than spinning one that can only ever no-op.
  const wantBadge = !hidden && subscribers > 0 && listWatchers === 0 && isLoggedIn();
  if (wantBadge && !badgeTimer) {
    badgeTimer = setInterval(() => { void refreshBadge(); }, BADGE_MS);
  } else if (!wantBadge && badgeTimer) {
    clearInterval(badgeTimer); badgeTimer = undefined;
  }
}

function onVisibility() {
  if (!document.hidden) {
    // Catch up on whatever landed while we were away — the cheap call unless the list is showing.
    if (listWatchers > 0) void refresh(true); else void refreshBadge();
  }
  sync();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisibility);
}

/** Subscribe to the store (badge-level). The first subscriber boots the session. */
export function subscribeChat(fn: () => void): () => void {
  subs.add(fn);
  subscribers++;
  // Badge only. Emphatically NOT bootChat() — see its docblock: publishing a device key merely
  // because a number is on screen would rotate the member's real key from any incidental browser.
  if (subscribers === 1) void refreshBadge();
  sync();
  return () => {
    subs.delete(fn);
    subscribers = Math.max(0, subscribers - 1);
    sync();
  };
}

/** Declare that this surface is SHOWING the conversation list, so the list may be polled (and
 *  presence-marking reads are acceptable). Call from the dock only while it is open, and from the
 *  full Messages page. Returns a release function. */
export function watchList(): () => void {
  listWatchers++;
  if (listWatchers === 1) {
    void bootChat().then(() => { void refresh(); sync(); });
  }
  sync();
  return () => {
    listWatchers = Math.max(0, listWatchers - 1);
    sync();
  };
}
