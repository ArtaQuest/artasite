// Optimistic vote casting — ONE mechanism for every vote arrow on the platform (public threads,
// thread comments, section/competition boards). Reddit-feel rules:
//   1. The UI updates the INSTANT you tap (no spinner, no disabled arrows).
//   2. Requests per target are LATEST-WINS: tap up-down-up quickly and only the newest in-flight
//      response is applied, so the arrows always settle on what you last asked for.
//   3. The server's response carries the AUTHORITATIVE score (it can differ when others are voting
//      at the same time) — the count reconciles to it when the dust settles.
//   4. A failed cast rolls back to the last server-confirmed state and surfaces the error.

export type VoteSnapshot = { votes: number; myVote: number };

/** Reddit toggle: tapping the arrow you've already cast clears it, otherwise cast that direction. */
export function nextVote(myVote: number, dir: 1 | -1): -1 | 0 | 1 {
  return myVote === dir ? 0 : dir;
}

export function createVoteCaster<Id extends string | number>(opts: {
  /** POST the DESIRED end state (-1 | 0 | 1) — set semantics, so a retry can never flip a vote. */
  send: (id: Id, val: -1 | 0 | 1) => Promise<{ my_vote: number; votes: number }>;
  /** Read the target's current on-screen snapshot (from a ref, not a stale closure). */
  read: (id: Id) => VoteSnapshot | null;
  /** Write a snapshot back into the page state (functional setState). */
  write: (id: Id, s: VoteSnapshot) => void;
  /** A cast settled with my_vote — lets boards derive side state (e.g. "upvoted a peer" step). */
  onSettle?: (id: Id, s: VoteSnapshot) => void;
  onError?: (id: Id, e: unknown) => void;
}) {
  const seq = new Map<Id, number>(); // newest request # per target — older responses are ignored
  const confirmed = new Map<Id, VoteSnapshot>(); // last server-confirmed state (rollback anchor)

  return function cast(id: Id, dir: 1 | -1) {
    const cur = opts.read(id);
    if (!cur) return;
    if (!confirmed.has(id)) confirmed.set(id, cur);
    const my = nextVote(cur.myVote, dir);
    opts.write(id, { myVote: my, votes: cur.votes + (my - cur.myVote) }); // instant
    const n = (seq.get(id) ?? 0) + 1;
    seq.set(id, n);
    opts.send(id, my).then(
      (r) => {
        if (seq.get(id) !== n) return; // a newer tap is in flight — it reconciles instead
        const s = { myVote: r.my_vote, votes: r.votes };
        confirmed.set(id, s);
        opts.write(id, s);
        opts.onSettle?.(id, s);
      },
      (e) => {
        if (seq.get(id) !== n) return;
        opts.write(id, confirmed.get(id)!); // roll back to the last truth we saw
        opts.onError?.(id, e);
      },
    );
  };
}
