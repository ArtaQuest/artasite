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
  chatGetVault, chatList, chatRegisterKey, chatSetVault, chatUnread,
  type ChatBox, type ChatKey, type ChatListPage, type ChatRing,
} from "./api";
import {
  adoptIdentity, decodePayload, deriveChatKey, e2eeSupported, ensureIdentity, hasIdentity, importPeerPub,
  newRecoveryCode, openMessage, rememberKid, unwrapIdentity, wrapIdentity,
  type ChatPayload, type Identity,
} from "./e2ee";
import { isLoggedIn } from "./wp";

/** How often the conversation LIST refreshes while a surface is actually showing it. */
const POLL_MS = 15000;
/** How often the collapsed dock refreshes just its unread badge. Slower than the list, and via a
 *  route that touches no presence — see the note on `watchList` below.
 *
 *  It is also the only thing listening for an inbound CALL, which is why it is 30s rather than the
 *  60s a badge alone would want: a ring nobody hears is not a call. Chat::RING_S is set longer than
 *  this on purpose, so no ring can start and expire between two polls. */
const BADGE_MS = 30000;

export type ChatState = {
  identity: Identity | null;
  myKey: ChatKey | null;
  page: ChatListPage | null;
  /** chat id → decrypted one-line preview ("You: …" when it was ours). */
  previews: Record<number, string>;
  /** Total unread across every conversation — what the dock's badge shows. Excludes muted,
   *  archived and un-accepted conversations: see Chat::unread for why a badge must not count them. */
  unread: number;
  /** Message requests waiting on this member's yes-or-no. Counted separately from `unread` on
   *  purpose — accepting a stranger is a decision, not an unread message. */
  requests: number;
  /** Somebody ringing right now, from the badge poll, so a call reaches the member on any page. */
  ring: ChatRing | null;
  /** Which list `page` currently holds. Boxes share one poller, so switching box re-fetches. */
  box: ChatBox;
  /** A hard failure that leaves messaging unusable (no WebCrypto, boot failed). */
  fatal: string | null;
  /** What this device needs from the member before its history is complete.
   *  "none"    — the key here matches the escrowed one; nothing to do.
   *  "restore" — the member HAS an escrow and this device does not hold that key: entering the
   *              recovery code opens the whole history instead of starting a fresh epoch.
   *  "backup"  — no escrow exists yet, so this key is one cleared browser away from being gone. */
  recovery: "none" | "restore" | "backup";
  /** True once a conversation list has actually arrived — not merely once the key was registered. */
  ready: boolean;
  /** The list has never loaded and the last attempt failed (offline, timeout, 5xx). */
  listError: boolean;
};

let state: ChatState = {
  identity: null, myKey: null, page: null, previews: {}, unread: 0, requests: 0, ring: null,
  box: "chats", fatal: null, recovery: "none", ready: false, listError: false,
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
 * someone opened ArtaChat. If merely rendering a badge did it, then reading the feed in a private
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
      // ── RESTORE BEFORE MINTING ────────────────────────────────────────────────────────────
      // The old boot generated a key whenever this browser had none, and `Chat::active_key` makes
      // the newest key THE key — so simply opening ArtaChat on a second device silently took the
      // conversation with it and orphaned everything sealed to the first. Ask what the member
      // already has BEFORE creating anything: if an escrow exists and this device does not hold
      // that key, we say so and wait for the recovery code rather than starting a new epoch behind
      // their back. Creating a key is now something a member is told about, not a side effect of
      // opening a page.
      const vault = await chatGetVault().catch(() => ({ blob: null, fp: "", at: 0 }));
      // A DEVICE WITH SOMETHING TO RESTORE MINTS NOTHING. Creating a key here would register it, and
      // the newest registered key IS the member's key — so the throwaway this device made while
      // waiting for a recovery code would become the one peers seal to, and the restore that
      // followed would be a THIRD epoch. The member restores first, or writes nothing yet; that is
      // the correct order and it is why this asks before it creates.
      if (vault.blob && !(await hasIdentity())) {
        set({ recovery: "restore" });
        await refresh(true);
        return;
      }
      const identity = await ensureIdentity();
      const reg = await chatRegisterKey(identity.pubB64);
      // This device's key IS the escrowed one when the fingerprints agree.
      const recovery: ChatState["recovery"] = !vault.blob ? "backup" : (vault.fp === identity.fp ? "none" : "restore");
      set({ identity, myKey: reg.key, recovery }); // `ready` waits for the first list — see refresh()
      // Remember the key under the id it registered as, so this device keeps opening messages
      // sealed to it even after a later restore replaces the active identity.
      if (reg.key?.kid) await rememberKid(reg.key.kid, { privateKey: identity.priv, publicKey: identity.pub });
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

/**
 * Show a different list (inbox / requests / archived / blocked).
 *
 * The box is store state rather than a component's, because the poller is shared: if the page held
 * it locally, the 15-second tick would keep overwriting the member's chosen list with the inbox.
 */
export function setBox(box: ChatBox): void {
  if (state.box === box) return;
  set({ box, page: null, ready: false });   // `page` belongs to the old box — showing it under the new tab's heading would be a lie
  void refresh(true);
}

/** Pull the conversation list and decrypt any preview that actually changed. */
export async function refresh(force = false): Promise<void> {
  if (refreshing || !state.myKey) return;
  if (!force && state.page && Date.now() - lastRefresh < FRESH_MS) return;
  refreshing = true;
  lastRefresh = Date.now();
  const box = state.box;
  try {
    // A deadline, because the latch above is single-flight: without one, a request that never
    // settles (a dead socket, a proxy holding the connection) would leave `refreshing` true and
    // the conversation list frozen for the rest of the visit, with nothing on screen saying so.
    const page = await Promise.race([
      chatList(box),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
    // The member switched tabs while this was in flight — its rows belong to a list nobody is
    // looking at any more, and the newer request will land shortly.
    if (state.box !== box) return;
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
          const payload = decodePayload(plain);
          // A CALL HANDSHAKE IS NOT A MESSAGE. `rtc` rows are the newest thing in the conversation
          // for a moment after every call, and they describe nothing a person would want to read —
          // so the list keeps whatever it was showing rather than replacing it with a blank (which
          // then fell through to the generic "Encrypted message", making a chat you can read look
          // like one you cannot).
          if (payload.t === "rtc") {
            if (state.previews[c.id] !== undefined) previews[c.id] = state.previews[c.id];
            continue;
          }
          const line = previewOf(payload);
          if (line) {
            previews[c.id] = m.sender === page.me ? `You: ${line}` : line;
            previewFor.set(c.id, m.id);
          }
        }
      } catch { /* unopenable row — the list just shows its timestamp */ }
    }
    // Only the INBOX carries the badge. Summing whichever list happens to be open would make the
    // badge read 0 the moment somebody looked at their archive, and jump when they looked back.
    const unread = box === "chats"
      ? page.items.reduce((n, c) => n + (c.muted ? 0 : c.unread || 0), 0)
      : state.unread;
    // `ready` only becomes true once a list has actually arrived — flipping it at boot meant a
    // failed first load rendered as a confident "no conversations yet".
    set({
      page, previews, unread, ready: true, listError: false,
      requests: page.requests ?? state.requests,
      ring: acceptRing(page.ring ?? null),
    });
  } catch {
    // Keep the last good list, but say so when there has never been one.
    if (!state.page) set({ listError: true });
  }
  finally {
    refreshing = false;
    // The member switched tabs while this request was in flight. `refresh` is single-flight, so the
    // setBox() call that followed found the latch closed and returned immediately — leaving the new
    // tab empty until the 15-second poll came round. Chase it now instead.
    if (state.box !== box) { void refresh(true); }
  }
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
    case "stick": return "🩵 Sticker";
    case "call":
      return p.act === "start" ? "📹 Call"
        : p.why === "missed" ? "📹 Missed call"
        : p.why === "declined" ? "📹 Call declined"
        : "📹 Call ended";
    case "rtc": return ""; // machinery — the caller above keeps the previous line instead
    default: return "";
  }
}

/**
 * Apply an accept/decline/mute/pin/archive locally, before the next poll agrees.
 *
 * Every one of these actions is about a list the member is looking at, so the row has to move (or
 * change) on the same tick they press the button. Waiting up to 15 seconds for the poller reads as
 * a dead button and invites a second press — which for `decline` means blocking somebody twice.
 */
export function applyRelation(peerId: number, patch: Partial<ChatListPage["items"][number]>, drop = false): void {
  const page = state.page;
  if (!page) return;
  const items = drop
    ? page.items.filter((c) => c.peer.id !== peerId)
    : page.items.map((c) => (c.peer.id === peerId ? { ...c, ...patch } : c));
  set({
    page: { ...page, items },
    unread: state.box === "chats" ? items.reduce((n, c) => n + (c.muted ? 0 : c.unread || 0), 0) : state.unread,
  });
}

/** The store's own count, adjusted without a round-trip when a request is answered. */
export function bumpRequests(delta: number): void {
  set({ requests: Math.max(0, state.requests + delta) });
}

/**
 * Stop showing an inbound ring — the member answered it, or dismissed it.
 *
 * The beacon lives on the SERVER for 75 seconds, so clearing local state alone is not enough: the
 * next badge poll re-reads the same live ring and the banner reappears a few seconds after being
 * dismissed, over and over until it expires. So a dismissal is remembered by identity — caller and
 * start time — and suppressed on arrival. A genuinely NEW call from the same person has a different
 * `at`, so it still rings.
 */
let dismissedRing = "";
const ringKey = (r: ChatRing | null) => (r ? `${r.from.id}:${r.at}` : "");

export function clearRing(): void {
  if (state.ring) {
    dismissedRing = ringKey(state.ring);
    set({ ring: null });
  }
}

/** Apply an incoming ring unless it is the one the member has already waved away. */
function acceptRing(r: ChatRing | null): ChatRing | null {
  return r && ringKey(r) === dismissedRing ? null : r;
}

// ── "Answer" has to mean answer ──────────────────────────────────────────────
//
// The ring banner can appear anywhere on the site, but the OFFER it belongs to lives inside the
// conversation — that is the whole design: the server holds a beacon, never the handshake. So
// pressing Answer necessarily opens the thread first, and it used to stop there: the member landed
// in the conversation looking at a second Answer button, having already answered. A button that
// does not do what it says is worse than no button.
//
// So the press ARMS the intent, and the thread consumes it the moment the offer is in front of it.
// One-shot and peer-scoped, so it can never auto-answer a later, unrelated call.

let armedFor = 0;

/** Remember that the member pressed Answer for this peer, before the thread that can act on it
 *  has even mounted. */
export function armAutoAnswer(peerId: number): void {
  armedFor = peerId;
}

/** Consume the intent, if it was for this peer. Returns true exactly once per press. */
export function takeAutoAnswer(peerId: number): boolean {
  if (armedFor !== peerId) return false;
  armedFor = 0;
  return true;
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

/** Refresh the badge state — unread, waiting requests, and any inbound ring. No presence, no
 *  ciphertext, no decryption: a server-side count and a 75-second beacon. */
async function refreshBadge(): Promise<void> {
  if (!isLoggedIn()) return; // no identity needed: this is a server-side count, not a decryption
  try {
    const r = await chatUnread();
    const ring = acceptRing(r.ring);
    if (r.unread !== state.unread || r.requests !== state.requests || !!ring !== !!state.ring
      || ring?.at !== state.ring?.at) {
      set({ unread: r.unread, requests: r.requests, ring });
    }
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
 *  full ArtaChat page. Returns a release function. */
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


/**
 * Turn on recovery: mint a code, seal THIS device's key under it, and store the sealed blob.
 *
 * Returns the code, which is shown once and never stored anywhere — not here, not on the server,
 * not in the database. If the member loses it, the escrow is a blob nobody can open, which is the
 * same position they are in today, and the reason the UI insists they write it down first.
 */
export async function enableRecovery(): Promise<string> {
  const { identity } = getChatState();
  if (!identity) throw new Error("no identity");
  const code = newRecoveryCode();
  const blob = await wrapIdentity(identity.priv, code);
  await chatSetVault(blob, identity.fp);
  set({ recovery: "none" });
  return code;
}

/**
 * Restore the member's key on this device from their recovery code.
 *
 * On success this device adopts the SAME private key the escrow holds, re-registers its public half
 * — which `Chat::set_key` recognises as already-current, so nothing rotates — and every message
 * sealed to that key becomes readable here. The previously-held device key is kept under its own
 * kid, so anything sealed to THAT stays readable too rather than turning into a wall of apology.
 */
export async function restoreFromCode(code: string): Promise<boolean> {
  const vault = await chatGetVault().catch(() => ({ blob: null, fp: "", at: 0 }));
  if (!vault.blob) return false;
  const pair = await unwrapIdentity(vault.blob, code);
  if (!pair) return false;                       // wrong code — GCM refused to authenticate
  const identity = await adoptIdentity(pair);
  const reg = await chatRegisterKey(identity.pubB64);
  if (reg.key?.kid) await rememberKid(reg.key.kid, pair);
  set({ identity, myKey: reg.key, recovery: "none" });
  // RELOAD, deliberately. Everything already on screen was decrypted — or failed to be — with the
  // key this device had a moment ago: the open thread's messages, its derived-key cache, and the
  // list's previews are all downstream of an identity that has just been replaced. Re-deriving each
  // of those in place is several caches to invalidate correctly and one to forget; a member who has
  // just typed a recovery code is not in a hurry, and this way every surface comes back correct.
  if (typeof window !== "undefined") window.location.reload();
  return true;
}
