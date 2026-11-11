// TCP congestion control, one round trip at a time.
//
// The sender may have `cwnd` segments in flight (its congestion window). It learns about the network
// only from what comes back: ACKs mean "the path can take this", a loss means "too much". This model
// counts in round trips (RTTs) and whole segments, as textbooks draw it:
//
// * slow start: cwnd doubles every RTT (one more segment per ACK) until it reaches `ssthresh`;
// * congestion avoidance: then it grows by one segment per RTT (additive increase);
// * on a loss: halve (multiplicative decrease). How depends on the variant and on how the loss was seen:
//   three duplicate ACKs (the network still delivers, one segment is missing) or a timeout (nothing
//   comes back at all).

export type Variant = "Tahoe" | "Reno";
export type Phase = "slow start" | "congestion avoidance";
export type LossKind = "triple duplicate ACK" | "timeout";

export interface Scenario {
  variant: Variant;
  rounds: number;
  /** Initial slow-start threshold, in segments. */
  ssthresh: number;
  /** The path holds this many segments per RTT; sending more overflows a router queue and loses one
   *  (seen as three duplicate ACKs). Infinity = never. */
  capacity: number;
  /** Extra losses at given rounds, e.g. a timeout at round 20. */
  events?: { round: number; kind: LossKind }[];
}

export interface Round {
  round: number;
  /** Window used during this round. */
  cwnd: number;
  ssthresh: number;
  phase: Phase;
  /** Segments that got through this round. */
  delivered: number;
  loss: LossKind | null;
  note: string;
}

export function simulate(s: Scenario): Round[] {
  if (s.rounds < 1 || s.rounds > 500) throw new RangeError("rounds must be between 1 and 500");
  if (!(s.ssthresh >= 2)) throw new RangeError("ssthresh must be at least 2");
  if (!(s.capacity >= 1)) throw new RangeError("capacity must be at least 1");
  let cwnd = 1;
  let ssthresh = s.ssthresh;
  const out: Round[] = [];
  for (let round = 1; round <= s.rounds; round++) {
    const phase: Phase = cwnd < ssthresh ? "slow start" : "congestion avoidance";
    const scheduled = s.events?.find((e) => e.round === round)?.kind ?? null;
    const overflow = cwnd > s.capacity;
    const loss: LossKind | null = scheduled ?? (overflow ? "triple duplicate ACK" : null);
    const delivered = loss === "timeout" ? 0 : Math.min(cwnd, s.capacity) - (loss ? 1 : 0);
    let note: string;
    const used = cwnd;
    const thresholdBefore = ssthresh;
    if (loss) {
      ssthresh = Math.max(2, Math.floor(cwnd / 2));
      if (loss === "timeout" || s.variant === "Tahoe") {
        cwnd = 1;
        note = `${loss === "timeout" ? "Timeout" : "Three duplicate ACKs"}: ssthresh = ${used} / 2 = ${ssthresh}, and ${s.variant === "Tahoe" && loss !== "timeout" ? "Tahoe treats every loss the same: " : ""}cwnd back to 1 — slow start again.`;
      } else {
        cwnd = ssthresh;
        note = `Three duplicate ACKs: the network is still delivering, so Reno halves instead of starting over (fast recovery): ssthresh = cwnd = ${ssthresh}.`;
      }
    } else if (phase === "slow start") {
      cwnd = Math.min(cwnd * 2, ssthresh);
      note = `Slow start: every ACK adds a segment, so the window doubles each round trip${cwnd === ssthresh ? ` — up to ssthresh (${ssthresh}), where slow start ends` : ""}.`;
    } else {
      cwnd += 1;
      note = "Congestion avoidance: one more segment per round trip — probing gently for spare capacity.";
    }
    out.push({ round, cwnd: used, ssthresh: thresholdBefore, phase, delivered, loss, note });
  }
  return out;
}

/** Segments delivered per round, averaged over the run. */
export function throughput(rounds: readonly Round[]): number {
  return rounds.reduce((n, r) => n + r.delivered, 0) / rounds.length;
}

// ---- AIMD fairness: two flows sharing one link -----------------------------------------------------------

export interface FairnessStep {
  round: number;
  a: number;
  b: number;
  /** Both flows saw a loss this round (the link overflowed). */
  loss: boolean;
}

/** Two AIMD flows (additive increase 1, multiplicative decrease ½) on a link of `capacity` segments
 *  per RTT. When their sum exceeds it, both lose and halve. Whatever the start, they converge to equal
 *  shares: each halving halves the *difference* between them, each increase leaves it unchanged. */
export function fairness(startA: number, startB: number, capacity: number, rounds: number): FairnessStep[] {
  let a = startA;
  let b = startB;
  const out: FairnessStep[] = [];
  for (let round = 1; round <= rounds; round++) {
    const loss = a + b > capacity;
    out.push({ round, a, b, loss });
    if (loss) {
      a /= 2;
      b /= 2;
    } else {
      a += 1;
      b += 1;
    }
  }
  return out;
}
