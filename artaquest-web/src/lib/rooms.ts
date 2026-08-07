/**
 * The room key, on this device.
 *
 * A room has ONE symmetric key per epoch. Getting hold of it means asking the server for MY sealed
 * copy and unwrapping it with the pairwise key I share with whoever sealed it — the ordinary DM key
 * exchange, reused (see lib/e2ee sealRoomKey/openRoomKey). Handing it on means the reverse, for each
 * member who does not have it yet.
 *
 * THE BOOTSTRAP, and why it is not circular: the member who CREATES a room mints the key locally and
 * seals it to themselves first. Anyone invited afterwards has it sealed to them by whichever member
 * is looking at the room when they arrive — which is why `distribute` runs on every room open rather
 * than only at invite time. An invite from a device that then closes its laptop must not leave
 * somebody permanently unable to read a room they are a member of.
 *
 * Keys are cached per room for the tab's lifetime and never persisted: this is a session's working
 * copy, and an unwrapped group key sitting in IndexedDB is a worse trade than unwrapping it again.
 */
import {
  roomsGetKey, roomsPending, roomsPutKey,
  type Room,
} from "./api";
import { deriveChatKey, ensureIdentity, importPeerPub, newRoomKey, openRoomKey, sealRoomKey } from "./e2ee";


/** roomId → its key for the CURRENT epoch, plus which epoch that was. */
const keys = new Map<number, { epoch: number; key: CryptoKey }>();
/** In-flight loads, so N callers on one room open share one unwrap rather than racing. */
const loading = new Map<number, Promise<CryptoKey | null>>();

/** Forget a room's key — on leaving, or when the epoch moves under us. */
export function forgetRoomKey(roomId: number): void {
  keys.delete(roomId);
  loading.delete(roomId);
}

/** The pairwise key I share with `peer`, for the device-key epoch the server named. */
async function pairKeyWith(me: number, peer: number, akid: number, bkid: number, pubs: Record<number, { user_id: number; pub: string }>) {
  const id = await ensureIdentity();
  const low = Math.min(me, peer);
  const high = Math.max(me, peer);
  // The peer's pub is whichever of the two named keys is not mine.
  const peerEntry = Object.values(pubs).find((k) => k.user_id === peer);
  if (!peerEntry) return null;
  return deriveChatKey(id.priv, await importPeerPub(peerEntry.pub), low, high, akid, bkid);
}

/**
 * This device's copy of a room's key, unwrapping it if needed.
 *
 * Returns null when nobody has sealed it to me yet — which is a real, temporary state (I have been
 * invited, and the next member to open the room will hand it over), not an error. The UI says so
 * rather than showing an empty conversation.
 */
export async function roomKey(room: Room, me: number): Promise<CryptoKey | null> {
  const have = keys.get(room.id);
  if (have && have.epoch === room.epoch) return have.key;
  if (have) keys.delete(room.id); // the epoch rotated — the old key is not this room's key any more
  const inflight = loading.get(room.id);
  if (inflight) return inflight;

  const job = (async (): Promise<CryptoKey | null> => {
    try {
      const r = await roomsGetKey(room.id);
      if (!r.key) {
        // Nobody has sealed it to me. If I am ALONE in the room, there is nobody to wait for — this
        // is a new room (or my own), so mint it here and seal it to myself.
        if (room.count === 1 && room.members[0]?.id === me) {
          const key = await newRoomKey();
          const mine = await myDeviceKid(room.id, me);
          if (!mine) return null;
          const ok = await sealUsing(room.id, r.epoch, me, mine.kid, me, mine.kid, mine.pub, key);
          if (!ok) return null;
          keys.set(room.id, { epoch: r.epoch, key });
          return key;
        }
        return null;
      }
      const pair = await pairKeyWith(me, r.key.from, r.key.akid, r.key.bkid, r.keys || {});
      if (!pair) return null;
      const key = await openRoomKey(r.key.iv, r.key.ct, pair);
      if (key) keys.set(room.id, { epoch: r.key.epoch, key });
      return key;
    } finally {
      loading.delete(room.id);
    }
  })();
  loading.set(room.id, job);
  return job;
}

/**
 * MY OWN current device key id, from the server.
 *
 * It used to come from the chat store — and that store is only booted by surfaces that show the
 * CONVERSATION list, so on the Rooms tab it was empty, `myKid` was undefined, and a brand-new room
 * silently never minted its key. The room API already reports it two ways, both authoritative:
 * `pending` lists me with my device key while I lack the room key, and once I hold it my own key row
 * names it. No second source of truth.
 */
async function myDeviceKid(roomId: number, me: number): Promise<{ kid: number; pub: string } | null> {
  const { items } = await roomsPending(roomId);
  const mine = items.find((i) => i.user.id === me);
  if (mine) return { kid: mine.kid, pub: mine.pub };
  const k = await roomsGetKey(roomId);
  if (!k.key) return null;
  // akid belongs to the LOW uid of the sealing pair, bkid to the high.
  const kid = me < k.key.from ? k.key.akid : k.key.bkid;
  const pub = Object.values(k.keys || {}).find((e) => e.user_id === me)?.pub;
  return pub ? { kid, pub } : null;
}

/**
 * Seal this room's key to one member and store it.
 */
async function sealUsing(roomId: number, epoch: number, me: number, myKid: number, target: number, targetKid: number, targetPub: string, key: CryptoKey): Promise<boolean> {
  if (!myKid) return false;
  const id = await ensureIdentity();
  const low = Math.min(me, target);
  const high = Math.max(me, target);
  // Sealing to MYSELF is the pair (me, me): both ids are mine, and ECDH against my own public key
  // is exactly what a self-chat already does.
  const akid = target === me ? myKid : (low === me ? myKid : targetKid);
  const bkid = target === me ? myKid : (low === me ? targetKid : myKid);
  const pair = await deriveChatKey(id.priv, await importPeerPub(targetPub), low, high, akid, bkid);
  const sealed = await sealRoomKey(key, pair);
  try {
    await roomsPutKey(roomId, { for: target, epoch, akid, bkid, iv: sealed.iv, ct: sealed.ct });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the key to every member who does not have it yet.
 *
 * Runs whenever a member with the key opens the room, not just when they invite somebody: an invite
 * whose sender closes their laptop a second later must not leave the invitee locked out of a room
 * they belong to. Any member can complete it, so somebody always will.
 */
export async function distributeRoomKey(room: Room, me: number): Promise<number> {
  const key = keys.get(room.id);
  if (!key || key.epoch !== room.epoch) return 0;
  let sealed = 0;
  try {
    const { items, epoch } = await roomsPending(room.id);
    const mine = await myDeviceKid(room.id, me);
    if (!mine) return 0;
    for (const it of items) {
      if (it.user.id === me) continue; // my own copy already exists, or roomKey() minted it
      if (await sealUsing(room.id, epoch, me, mine.kid, it.user.id, it.kid, it.pub, key.key)) sealed++;
    }
  } catch { /* transient — the next room open tries again */ }
  return sealed;
}
