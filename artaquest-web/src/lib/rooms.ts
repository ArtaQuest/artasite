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
import { chatRegisterKey, roomsGetKey, roomsPending, roomsPutKey, type Room } from "./api";
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
/**
 * Derive the pairwise key a sealed row was made under.
 *
 * The pub to derive against is chosen BY KID — the named key that is not this device's own. It used
 * to be chosen by user id ("whichever key belongs to the peer"), which is right for two people and
 * wrong for the one case that matters most: a member sealing the room key to their OWN second
 * browser. Both named keys belong to them, so picking by user id picked whichever came first in the
 * map — frequently this device's own key, deriving a shared secret with itself and opening nothing.
 * That is the case that lets somebody back in without waiting for another human to be online.
 */
async function pairKeyWith(mine: { kid: number; priv: CryptoKey }, me: number, peer: number,
  akid: number, bkid: number, pubs: Record<number, { user_id: number; pub: string }>) {
  const low = Math.min(me, peer);
  const high = Math.max(me, peer);
  const otherKid = akid === mine.kid ? bkid : akid;
  const entry = pubs[otherKid];
  if (!entry) return null;
  return deriveChatKey(mine.priv, await importPeerPub(entry.pub), low, high, akid, bkid);
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
      // Register first, then ask. Registering is idempotent and returns THIS browser's kid — the row
      // to ask for, and the key to derive with. It also marks the key as the one in use, which is
      // what puts this device on the list a present key-holder seals to.
      const mine = await myMintKid();
      const r = await roomsGetKey(room.id, mine?.kid || 0);
      if (!r.key) {
        // Nobody has sealed it to me. If I am ALONE in the room and the room has NO key at all, there
        // is nobody to wait for — this is a new room, so mint it and seal it to myself.
        //
        // `sealed` is the whole guard. Rows are per device, so "no row for me" no longer means "no
        // key exists": opening a room in a second browser finds no row of its own, and without this
        // it would mint a SECOND key at the same epoch. Both devices would then hold a key, and
        // neither could read anything the other sent.
        if (!r.sealed && room.count === 1 && room.members[0]?.id === me) {
          const key = await newRoomKey();
          // MINT WITH THIS BROWSER'S OWN KEY, resolved from the identity rather than from the
          // server's idea of my newest one.
          //
          // The key to seal with is THIS browser's, and registering our own public half returns its
          // kid — idempotently, because Chat::set_key returns the existing id for a public key
          // already in this member's history.
          if (!mine) return null;
          const ok = await sealUsing(room.id, r.epoch, me, mine.kid, mine.priv, me, mine.kid, mine.pub, key);
          if (!ok) return null;
          keys.set(room.id, { epoch: r.epoch, key });
          return key;
        }
        return null;
      }
      if (!mine) return null;
      const pair = await pairKeyWith(mine, me, r.key.from, r.key.akid, r.key.bkid, r.keys || {});
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
 * The kid for THIS browser's own key, for minting.
 *
 * THE one question worth asking: which key does THIS browser hold? Everything that seals or unwraps
 * needs that and nothing else. Asking the server which key is "the member's current one" is a
 * different question with a different answer as soon as somebody opens a second browser, and every
 * lockout in this file came from confusing the two. Registering is how we learn the id, and it is
 * safe to repeat.
 */
async function myMintKid(): Promise<{ kid: number; pub: string; priv: CryptoKey } | null> {
  try {
    const mine = await ensureIdentity();
    const reg = await chatRegisterKey(mine.pubB64);
    const kid = reg?.key?.kid ?? 0;
    return kid ? { kid, pub: mine.pubB64, priv: mine.priv } : null;
  } catch { return null; }
}

/**
 * Seal this room's key to one member and store it.
 */
async function sealUsing(roomId: number, epoch: number, me: number, myKid: number, myPriv: CryptoKey, target: number, targetKid: number, targetPub: string, key: CryptoKey): Promise<boolean> {
  if (!myKid) return false;
  // The caller hands in the key that BELONGS to myKid. A row that names one key and was sealed with
  // another authenticates for nobody, and the server cannot tell the difference — so this function
  // no longer chooses; myDeviceKid resolves the pair together or returns nothing.
  const low = Math.min(me, target);
  const high = Math.max(me, target);
  // Sealing to MYSELF names both of my own keys — the same one twice when it is this very device
  // (the mint), and two different ones when it is my other browser. The recipient picks the pub that
  // is not its own, so both cases derive correctly.
  const akid = target === me ? myKid : (low === me ? myKid : targetKid);
  const bkid = target === me ? targetKid : (low === me ? targetKid : myKid);
  const pair = await deriveChatKey(myPriv, await importPeerPub(targetPub), low, high, akid, bkid);
  const sealed = await sealRoomKey(key, pair);
  try {
    await roomsPutKey(roomId, { for: target, for_kid: targetKid, epoch, akid, bkid, iv: sealed.iv, ct: sealed.ct });
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
    // THIS DEVICE's key, asked directly. It used to ask the server which key was "mine", which is a
    // question about the MEMBER — and the moment a second browser registered, the answer was that
    // browser's. This one could not seal with a key it does not hold, so it returned nothing and
    // sealed to nobody: the device that actually had the room key went quiet, and the new browser
    // waited for a hand-over that was never coming. Registering is idempotent and returns the kid.
    const mine = await myMintKid();
    if (!mine) return 0;
    for (const it of items) {
      // MY OWN OTHER BROWSERS COUNT. This skipped every entry for me, on the assumption that my own
      // copy must already exist — true when a member had one device, false the moment they had two.
      // It meant the one person guaranteed to hold the key could not hand it to their own second
      // browser, so getting back in needed somebody ELSE to be on the page at that moment. Only this
      // device's own row is genuinely already there.
      if (it.user.id === me && it.kid === mine.kid) continue;
      if (await sealUsing(room.id, epoch, me, mine.kid, mine.priv, it.user.id, it.kid, it.pub, key.key)) sealed++;
    }
  } catch { /* transient — the next room open tries again */ }
  return sealed;
}
