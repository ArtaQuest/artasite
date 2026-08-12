/**
 * THE ANCHOR — who in a call carries the shared work.
 *
 * WHAT THIS IS NOT. It is not the meeting's host. A mesh call has no server in the middle, so
 * nobody is relaying anybody's media and there is no traffic to move from one person to another by
 * appointing them: five people is four uplinks each whoever is "in charge". And the host role in
 * ArtaMeet is a SOCIAL one — it invites, retimes and cancels — which must not be auctioned to
 * whoever happens to have the better wifi. Someone on a train should not lose the ability to cancel
 * their own meeting to someone on fibre.
 *
 * WHAT IT IS. There is work in a call that only needs doing ONCE, by ONE participant, and today
 * every key-holder does it on every tick: sealing the room key to whoever has just arrived. That
 * work is worth giving to the best-connected person in the room, because a newcomer's wait to get
 * in currently depends on whichever peer happens to answer first — which may be the one on the
 * worst link. Electing an anchor makes the redundancy stop and makes the answer come from the
 * steadiest place.
 *
 * STEADY BEATS FAST, and that is the whole point of the score below. A link that peaks at 5 Mbit/s
 * and collapses every thirty seconds is worse for this job than one that sits at 800 kbit/s and
 * never moves: the work is a handful of small writes that must SUCCEED, not a bulk transfer. So
 * throughput is taken as a median rather than a peak, jitter is penalised on its own account, and a
 * link that has actually been failing recently — one that has had to shed video — is marked down
 * for it however good its numbers look in the moment.
 *
 * THE ELECTION NEEDS NO NEGOTIATION. Every participant publishes its own score into the room as an
 * ordinary sealed payload, so everyone holds the same table and applies the same rule to it. There
 * is no proposal, no vote and no coordinator to lose — the answer is a function of the table, and
 * two peers with the same table always reach the same answer. Ties break on the lowest member id
 * because it is arbitrary and identical everywhere.
 */

/** One participant's self-reported link, as it travels between peers. */
export type LinkScore = {
  /** 0-100. Higher is better. See score() for what it means. */
  score: number;
  /** When this was measured, ms since epoch, by the sender's clock. */
  at: number;
};

/** What one peer knows about everyone's link, including its own. */
export type ScoreTable = Record<number, LinkScore>;

/** A sample of our own outgoing link, taken from the call's statistics. */
export type Sample = { kbps: number; lossPct: number; rttMs: number; shed: boolean };

/** How many samples before a link has said anything worth believing. An unproven link never wins. */
export const MIN_SAMPLES = 5;
/** Samples kept. At one every two seconds this is about half a minute of history. */
export const WINDOW = 15;
/** A score older than this is not evidence — the peer may have left, frozen, or gone quiet. */
export const STALE_MS = 20_000;
/** A challenger must beat the incumbent by this much to be worth the disruption of a change. */
export const MARGIN = 12;
/** …and must keep beating it this many evaluations running. Both together are what stop flapping. */
export const HOLD = 3;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean absolute deviation — how much a number MOVES, which is the half of stability that an
 *  average hides. Two links averaging 300ms are not the same link if one of them never varies. */
function jitter(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + Math.abs(b - mean), 0) / xs.length;
}

/**
 * Score a window of samples, 0-100.
 *
 * The weights say what this job needs: it is a few small writes that have to land, so LOSS and
 * VARIABILITY matter more than headroom. A link with 2 Mbit/s and 6% loss scores below one with
 * 500 kbit/s and none, because the second will complete the work first time and the first will not.
 *
 * Returns 0 — meaning "not a candidate" — until there is enough history to be judging at all.
 */
export function score(samples: Sample[]): number {
  if (samples.length < MIN_SAMPLES) return 0;
  const win = samples.slice(-WINDOW);
  const kbps = win.map((s) => s.kbps).filter((k) => k > 0);
  const loss = win.map((s) => s.lossPct);
  const rtts = win.map((s) => s.rttMs).filter((r) => r > 0);

  // Throughput, by its MEDIAN: one lucky second does not make a link fast.
  const thru = median(kbps);
  const thruPts = Math.min(30, (thru / 1200) * 30);          // 1.2 Mbit/s is full marks; more is not better here

  // Loss, by its WORST sample in the window, not its average. A link that is clean for nine
  // samples and loses a tenth of its packets on the tenth is not a clean link, and averaging is
  // exactly how that gets hidden.
  const worstLoss = loss.length ? Math.max(...loss) : 0;
  const lossPts = Math.max(0, 30 - worstLoss * 5);           // 6% loss spends the whole allowance

  // Round trip, and separately how much it MOVES.
  const rtt = median(rtts);
  const rttPts = Math.max(0, 20 - (rtt / 400) * 20);         // 400ms spends the whole allowance
  const jit = jitter(rtts);
  const steadyPts = Math.max(0, 20 - (jit / 100) * 20);      // 100ms of wander spends it

  // A link that has actually had to give up video recently is not a steady link, whatever the
  // instantaneous numbers say. This is the difference between measuring a link and trusting it.
  const shed = win.filter((s) => s.shed).length;
  const penalty = shed * 8;

  return Math.max(0, Math.min(100, Math.round(thruPts + lossPts + rttPts + steadyPts - penalty)));
}

/**
 * Who should be carrying the shared work, given what everyone has published.
 *
 * `incumbent` is who is doing it now; `held` is how many consecutive evaluations the same
 * challenger has been ahead by MARGIN. Returns the decision AND the new counter, because the
 * hysteresis has to live somewhere and a pure function is the only place it can be tested.
 *
 * A stale score is not evidence: a peer that has stopped publishing may have left, or frozen, and
 * the one thing worse than a slow anchor is an absent one.
 */
export function elect(
  table: ScoreTable,
  incumbent: number,
  held: number,
  now: number,
): { anchor: number; held: number } {
  const live = Object.entries(table)
    .map(([uid, s]) => ({ uid: Number(uid), ...s }))
    .filter((e) => e.score > 0 && now - e.at < STALE_MS);
  if (!live.length) return { anchor: incumbent, held: 0 };

  // Best score wins; the lowest id breaks a tie because it is arbitrary and every peer computes
  // the same one without asking anybody.
  live.sort((a, b) => (b.score - a.score) || (a.uid - b.uid));
  const best = live[0];
  const cur = live.find((e) => e.uid === incumbent);

  // Nobody is doing it, or whoever was has gone quiet: take the best there is, at once. Waiting out
  // the hysteresis here would leave newcomers unable to get into the room for no reason.
  if (!incumbent || !cur) return { anchor: best.uid, held: 0 };
  if (best.uid === incumbent) return { anchor: incumbent, held: 0 };

  // Someone is better. Changing anchor is cheap but not free, and a link that is better for one
  // sample is not better — so a challenger has to be clearly ahead, and stay ahead.
  if (best.score - cur.score < MARGIN) return { anchor: incumbent, held: 0 };
  const next = held + 1;
  return next >= HOLD ? { anchor: best.uid, held: 0 } : { anchor: incumbent, held: next };
}

/* ── WHERE THE ANSWER IS PUBLISHED ──────────────────────────────────────────────────────────────
 *
 * The election runs inside the call component, but the work it places — sealing the room key to
 * whoever has just arrived — is driven by the meeting page's own poll. Rather than thread a prop
 * through a boundary that runs the other way (the page renders the call), the result is left here,
 * in the module both already import. One value, one writer, read wherever it is needed.
 */
let anchored: { room: number; uid: number } = { room: 0, uid: 0 };

/** Called by the call component each time it re-elects. */
export function publishAnchor(room: number, uid: number): void {
  anchored = { room, uid };
}

/**
 * Should THIS device do the shared work for this room right now?
 *
 * Answers true when we are the anchor, and — importantly — also when there is no anchor at all.
 * An election that has not resolved must never mean nobody lets a newcomer in: duplicated work is
 * a cost, an unjoinable room is a failure.
 */
export function shouldAnchor(room: number, me: number): boolean {
  if (!anchored.uid || anchored.room !== room) return true;
  return anchored.uid === me;
}
