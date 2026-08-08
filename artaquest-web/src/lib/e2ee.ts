/**
 * End-to-end encryption for ArtaChat (Messages) — WebCrypto only, no dependencies.
 *
 * Threat model: the ENTIRE ArtaQuest database is public (the /data/ explorer serves every row),
 * so the server must never be able to read a message — and neither can anyone who downloads the
 * whole dataset. The construction:
 *
 *   identity   ECDH keypair on NIST P-256, generated in THIS browser with the private key
 *              non-extractable and stored only in this device's IndexedDB. It cannot be
 *              exported by script — the private key never exists outside the device, so the
 *              public DB physically cannot contain what's needed to decrypt (~2^128 EC work).
 *   direction  the public key (65-byte uncompressed point) is registered with the server;
 *              rotation appends (the registry is append-only, like every ArtaQuest ledger).
 *   session    conversation key = ECDH(myPriv, peerPub) → HKDF-SHA-256 (salt "ArtaQuest-DM-v1",
 *              info binds the ordered uid pair + BOTH key ids) → AES-256-GCM, non-extractable.
 *   message    fresh random 96-bit IV per message; the GCM additional-data binds the ciphertext
 *              to the conversation and sender, so a row cannot be replayed into another chat
 *              or attributed to the other party without failing authentication.
 *
 * Like X's encrypted DMs, keys are device-bound: clear the browser (or move device) and a new
 * key is registered — old ciphertext stays sealed to the old key ids (rendered as "sealed to a
 * previous device") because the server has nothing to re-encrypt with. That is the honest cost
 * of a public database.
 */

const DB_NAME = "aq-e2ee";
const STORE = "keys";
const IDENTITY = "identity";
const SALT = new TextEncoder().encode("ArtaQuest-DM-v1");

export type Identity = { priv: CryptoKey; pub: CryptoKey; pubB64: string; fp: string };

// ── small codecs ─────────────────────────────────────────────────────────────

export function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256hex(data: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── device identity (IndexedDB-persisted CryptoKeyPair) ─────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, val: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** True when this browser can run the chat crypto at all (secure context + WebCrypto). */
export function e2eeSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
}

/**
 * Load (or create on first use) this device's identity keypair. The private key is generated
 * NON-EXTRACTABLE and persisted as a CryptoKey via IndexedDB's structured clone — it can be
 * used by this origin on this device, but no script (ours or an attacker's) can export it.
 *
 * MEMOISED, and that memo is load-bearing rather than an optimisation. The body is a
 * read-then-write with an `await` between the read and the write, so two concurrent callers both
 * see an empty store and both generate a keypair — the second overwrites the first in IndexedDB
 * and registers an extra public key, which the server records as a ROTATION (Chat::set_key
 * appends). Every message sealed to the losing epoch is then unopenable forever, by anyone.
 *
 * That race is not hypothetical: React StrictMode double-invokes effects in development, and the
 * messaging surface is now mounted in two places (the dock and the /messages page). Sharing one
 * promise means every caller gets the same keypair, whatever the mount order.
 */
let identityPromise: Promise<Identity> | null = null;

export function ensureIdentity(): Promise<Identity> {
  if (!identityPromise) {
    identityPromise = createIdentity().catch((e) => {
      identityPromise = null; // a failed boot must be retryable, not cached forever
      throw e;
    });
  }
  return identityPromise;
}

async function createIdentity(): Promise<Identity> {
  const db = await openDb();
  let pair = await idbGet<CryptoKeyPair>(db, IDENTITY);
  if (!pair?.privateKey) {
    pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false, // non-extractable: the private key can never leave this device
      ["deriveKey", "deriveBits"],
    )) as CryptoKeyPair;
    await idbPut(db, IDENTITY, pair);
  }
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey); // public half is always exportable
  db.close();
  return { priv: pair.privateKey, pub: pair.publicKey, pubB64: b64encode(raw), fp: await sha256hex(raw) };
}

// ── conversation keys + message sealing ──────────────────────────────────────

export async function importPeerPub(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64decode(pubB64).buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/**
 * Derive the AES-256-GCM conversation key for one (key-pair epoch of a) chat. `info` binds the
 * ordered uid pair AND both registered key ids, so a key derived for one conversation/epoch can
 * never be confused with another's even if a party reuses their keypair across chats.
 */
export async function deriveChatKey(
  myPriv: CryptoKey,
  peerPub: CryptoKey,
  lowUid: number,
  highUid: number,
  akid: number,
  bkid: number,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, myPriv, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode(`aq-dm|${lowUid}|${highUid}|${akid}|${bkid}`);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The GCM additional-data for one message: chat pair + who sealed it (authenticated, not secret). */
function aad(lowUid: number, highUid: number, sender: number): Uint8Array {
  return new TextEncoder().encode(`aq-dm|${lowUid}|${highUid}|from:${sender}`);
}

export async function sealMessage(
  key: CryptoKey,
  text: string,
  lowUid: number,
  highUid: number,
  sender: number,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(lowUid, highUid, sender) as unknown as ArrayBuffer },
    key,
    new TextEncoder().encode(text),
  );
  return { iv: b64encode(iv.buffer), ct: b64encode(ct) };
}

/** Open one sealed message, or null when it fails to authenticate (wrong key epoch / tampered row). */
export async function openMessage(
  key: CryptoKey,
  ivB64: string,
  ctB64: string,
  lowUid: number,
  highUid: number,
  sender: number,
): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64decode(ivB64) as unknown as ArrayBuffer,
        additionalData: aad(lowUid, highUid, sender) as unknown as ArrayBuffer,
      },
      key,
      b64decode(ctB64) as unknown as ArrayBuffer,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/**
 * The conversation's safety code — the same 12 groups on both devices exactly when nobody is in
 * the middle: SHA-256 over both public keys in uid order, shown as digit groups (Signal-style).
 */
export async function safetyCode(pubLowB64: string, pubHighB64: string): Promise<string> {
  const a = b64decode(pubLowB64);
  const b = b64decode(pubHighB64);
  const joint = new Uint8Array(a.length + b.length);
  joint.set(a, 0);
  joint.set(b, a.length);
  const hex = await sha256hex(joint.buffer as ArrayBuffer);
  // 12 groups of 5 decimal digits from the leading hash bytes — readable over a phone call.
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const chunk = parseInt(hex.slice(i * 5, i * 5 + 5), 16) % 100000;
    groups.push(String(chunk).padStart(5, "0"));
  }
  return groups.join(" ");
}

// ── Sealed payloads (v2) ──────────────────────────────────────────────────────
// Every message row carries an identical-looking ciphertext whatever it means; the TYPE lives
// inside the sealed JSON, so the public DB cannot tell a reaction from an essay from a photo.
//   text  { v:2, t:"text",  body, ref? }            ref = replied-to message id
//   img   { v:2, t:"img",   att, body? }            att = sealed-attachment pointer
//   voice { v:2, t:"voice", att }                   att.dur = seconds
//   file  { v:2, t:"file",  att, body? }            any other media (video/audio/document);
//                                                   att.name/mime pick the inline renderer
//   react { v:2, t:"react", ref, emoji }            toggles: odd count of (sender,ref,emoji) = on
//   edit  { v:2, t:"edit",  ref, body }             latest edit by the original sender wins
//   del   { v:2, t:"del",   ref }                   live tombstone (chat/unsend removes the row)
//   stick { v:2, t:"stick", id }                    one of OUR OWN hosted animated stickers
//   call  { v:2, t:"call",  act }                   the VISIBLE record of a call in the history
//   rtc   { v:2, t:"rtc",   kind, sid, sdp? }       the call handshake itself — never rendered
//   draw  { v:2, t:"draw",  stroke|clear }          one whiteboard stroke — sealed like a sentence
// A payload that fails to parse as JSON is treated as v1 plain text.
//
// STICKERS carry an id, not bytes. They are ours, they are already on every device that has the
// app, and sealing 40 KB of the same SVG into the database on every wave would be theatre: the
// public row still says only "a message happened", which is exactly what it says for text. GIFs
// are NOT stickers — an uploaded or linked GIF is somebody's own file, so it goes through the
// ordinary sealed-attachment path as an `img` with `gif: true`.
//
// CALLS ARE TWO PAYLOADS, and the split matters.
//
//   `call` is the VISIBLE one: the bubble that says a call happened, and how it ended. It is what a
//   person reads back in the history months later.
//
//   `rtc` is the HANDSHAKE, and it is never rendered. WebRTC needs the two browsers to exchange an
//   SDP offer and answer before media can flow directly between them, and that exchange has to go
//   over some channel. Using THIS one — the sealed message pipe — is what makes a call as private
//   as a message: the offer carries the DTLS fingerprints that key the media, and the server holds
//   it as the same opaque ciphertext it holds everything else. There is no signalling server, and
//   no bridge; the two participants are the only parties to the call in the literal sense.
//
//   `sid` names the call, so an answer belonging to a call that already ended is discarded instead
//   of half-reviving it.
export type SealedAttachment = {
  blob: string;   // server reference name (….bin)
  url: string;    // public URL of the sealed bytes
  k: string;      // base64 raw AES-256-GCM key — travels ONLY inside the sealed message
  iv: string;     // base64 96-bit IV
  mime: string;
  size: number;
  name?: string;  // original filename (file attachments), sealed with the key
  w?: number;     // image pixel size (pre-seal), for layout
  h?: number;
  dur?: number;   // voice length (s)
  gif?: boolean;  // render as a GIF: never cropped, never a still, labelled as one
};
export type ChatPayload =
  | { v: 2; t: "text"; body: string; ref?: number }
  | { v: 2; t: "img"; att: SealedAttachment; body?: string; ref?: number }
  | { v: 2; t: "voice"; att: SealedAttachment; ref?: number }
  | { v: 2; t: "file"; att: SealedAttachment; body?: string; ref?: number }
  | { v: 2; t: "react"; ref: number; emoji: string }
  | { v: 2; t: "edit"; ref: number; body: string }
  | { v: 2; t: "del"; ref: number }
  | { v: 2; t: "stick"; id: string; ref?: number }
  /** The visible record of a call. `why` distinguishes a normal hangup from one nobody answered. */
  | { v: 2; t: "call"; act: "start" | "end"; sid?: string; dur?: number; why?: "declined" | "missed" | "failed" }
  /** The handshake. Never rendered; see the note above. */
  | { v: 2; t: "rtc"; kind: "offer" | "answer" | "bye"; sid: string; sdp?: string; to?: number }
  /** One whiteboard stroke, a clear, or an undo of the sender's own last stroke. Points are
   *  normalised 0..1 so the drawing is the same shape on a phone and a laptop — see
   *  components/chat/Whiteboard. */
  | { v: 2; t: "draw"; stroke?: { pts: [number, number][]; color: string; w: number }; clear?: boolean; undo?: boolean }
  /**
   * THE TEACHING TOOLS. Each is a tiny sealed payload rather than a server feature, which is what
   * makes the set EXTENSIBLE: another tool is another variant here plus a button, and it inherits
   * the room's encryption for free. Nothing about a raised hand or a running timer is ever legible
   * to the server.
   */
  | { v: 2; t: "hand"; up: boolean }
  /** A shared countdown. `ends` is a wall-clock ms timestamp so every screen agrees without anybody
   *  having to be the clock; null stops it. */
  | { v: 2; t: "timer"; ends: number | null; label?: string }
  /** "Look here" — a pulse on the board at a normalised point. Sent on TAP, never on move: a
   *  continuous pointer would be a message per frame per person. */
  | { v: 2; t: "point"; x: number; y: number };

export function encodePayload(p: ChatPayload): string {
  return JSON.stringify(p);
}

export function decodePayload(plain: string): ChatPayload {
  try {
    const j = JSON.parse(plain);
    if (j && j.v === 2 && typeof j.t === "string") return j as ChatPayload;
  } catch { /* v1 plain text */ }
  return { v: 2, t: "text", body: plain };
}

// ── Sealed attachments — Signal's attachment-pointer pattern ─────────────────
// Each file gets its own fresh AES-256-GCM key; the server stores only the sealed bytes, and
// the key+IV ride inside the (already end-to-end sealed) message that references them.

export async function sealAttachment(bytes: ArrayBuffer): Promise<{ sealed: Blob; k: string; iv: string }> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { sealed: new Blob([ct]), k: b64encode(raw), iv: b64encode(iv.buffer) };
}

/** Fetch + open a sealed attachment → an object URL for <img>/<audio>. Null when it fails.
 *  The URL travels inside a peer-sealed payload, so treat it as hostile: only our own blob
 *  store is ever fetched — a malicious peer must not be able to use this client as a tracking
 *  pixel against an external host. */
export async function openAttachment(att: SealedAttachment): Promise<string | null> {
  try {
    const u = new URL(att.url, window.location.origin);
    if (!/\/aq-chat\/[a-f0-9]{32}\.bin$/.test(u.pathname)) return null;
    const res = await fetch(window.location.origin + u.pathname); // never the sender's host
    if (!res.ok) return null;
    const ct = await res.arrayBuffer();
    const key = await crypto.subtle.importKey("raw", b64decode(att.k).buffer as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(att.iv) as unknown as ArrayBuffer }, key, ct);
    return URL.createObjectURL(new Blob([pt], { type: att.mime }));
  } catch {
    return null;
  }
}

// ── Group rooms ──────────────────────────────────────────────────────────────
//
// A room has ONE symmetric key. Messages are encrypted with it once, rather than once per member,
// and the key itself is handed out by SEALING IT WITH THE PAIRWISE KEY that already exists between
// two members — the same ECDH+HKDF above, unchanged. So a group needs no new key exchange and no new
// trust: if you can DM somebody, you can hand them a room key, and the server sees an opaque blob
// either way.
//
// The honest limits, which the UI states rather than hides:
//  • Removing somebody does not un-know the key they already hold. Excluding them from FUTURE
//    messages means rotating to a new epoch and re-sealing to everyone who remains.
//  • No forward secrecy within an epoch: whoever holds the key can read that epoch's history. A DM
//    has the same property per device-key epoch, so this is not a step down — but it is not a
//    double ratchet either.

/** A fresh room key. EXTRACTABLE on purpose: a member has to be able to re-seal it to somebody they
 *  invite, which means their browser must be able to export the raw bytes. It never leaves the
 *  device unsealed. */
export async function newRoomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Wrap a room key for one member, using the pairwise key derived with them. */
export async function sealRoomKey(roomKey: CryptoKey, pairKey: CryptoKey): Promise<{ iv: string; ct: string }> {
  const raw = await crypto.subtle.exportKey("raw", roomKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, pairKey, raw);
  return { iv: b64encode(iv.buffer), ct: b64encode(ct) };
}

/** …and unwrap it. Null when the pairwise key is the wrong epoch (their device key rotated). */
export async function openRoomKey(ivB64: string, ctB64: string, pairKey: CryptoKey): Promise<CryptoKey | null> {
  try {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(ivB64) as unknown as ArrayBuffer },
      pairKey,
      b64decode(ctB64) as unknown as ArrayBuffer,
    );
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

/** Room messages bind to the ROOM and the SENDER, so a row cannot be replayed into another room or
 *  re-attributed to somebody else without failing authentication. */
function roomAad(roomId: number, sender: number): Uint8Array {
  return new TextEncoder().encode(`aq-room|${roomId}|from:${sender}`);
}

export async function sealRoomMessage(key: CryptoKey, text: string, roomId: number, sender: number): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: roomAad(roomId, sender) as unknown as ArrayBuffer },
    key,
    new TextEncoder().encode(text),
  );
  return { iv: b64encode(iv.buffer), ct: b64encode(ct) };
}

export async function openRoomMessage(key: CryptoKey, ivB64: string, ctB64: string, roomId: number, sender: number): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64decode(ivB64) as unknown as ArrayBuffer,
        additionalData: roomAad(roomId, sender) as unknown as ArrayBuffer,
      },
      key,
      b64decode(ctB64) as unknown as ArrayBuffer,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
