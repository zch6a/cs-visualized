import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fairness, simulate, throughput, type Scenario } from "../src/sim/congestion.ts";

const base: Scenario = { variant: "Reno", rounds: 30, ssthresh: 16, capacity: Infinity };
const windows = (s: Scenario) => simulate(s).map((r) => r.cwnd);

test("slow start doubles the window each round trip, up to ssthresh, then grows by one", () => {
  assert.deepEqual(windows({ ...base, rounds: 9 }), [1, 2, 4, 8, 16, 17, 18, 19, 20]);
  const r = simulate({ ...base, rounds: 6 });
  assert.deepEqual(r.map((x) => x.phase), ["slow start", "slow start", "slow start", "slow start", "congestion avoidance", "congestion avoidance"]);
});

test("slow start stops exactly at a threshold that is not a power of two", () => {
  assert.deepEqual(windows({ ...base, ssthresh: 12, rounds: 7 }), [1, 2, 4, 8, 12, 13, 14]);
});

test("Tahoe: any loss halves ssthresh and restarts from one segment", () => {
  const r = simulate({ ...base, variant: "Tahoe", rounds: 12, events: [{ round: 8, kind: "triple duplicate ACK" }] });
  // Rounds 1–7: 1 2 4 8 16 17 18; round 8 has cwnd 19 and a loss → ssthresh 9, cwnd 1.
  assert.equal(r[7]!.cwnd, 19);
  assert.deepEqual(r.slice(8).map((x) => x.cwnd), [1, 2, 4, 8]);
  assert.equal(r[8]!.ssthresh, 9);
  assert.equal(r[11]!.phase, "slow start"); // 8 < 9
});

test("Reno: three duplicate ACKs halve the window; a timeout still restarts from one", () => {
  const dup = simulate({ ...base, rounds: 11, events: [{ round: 8, kind: "triple duplicate ACK" }] });
  assert.deepEqual(dup.slice(8).map((x) => x.cwnd), [9, 10, 11]);
  assert.equal(dup[8]!.phase, "congestion avoidance");
  const timeout = simulate({ ...base, rounds: 11, events: [{ round: 8, kind: "timeout" }] });
  assert.deepEqual(timeout.slice(8).map((x) => x.cwnd), [1, 2, 4]);
  assert.equal(timeout[7]!.delivered, 0);
});

test("a full link gives Reno its sawtooth between about half and all of the capacity", () => {
  const capacity = 20;
  const r = simulate({ ...base, rounds: 200, capacity });
  const steady = r.slice(50);
  const peaks = steady.filter((x) => x.loss).map((x) => x.cwnd);
  assert.ok(peaks.length > 5 && peaks.every((p) => p === capacity + 1), `losses happen just above capacity: ${peaks}`);
  assert.ok(steady.every((x) => x.cwnd >= Math.floor((capacity + 1) / 2)));
  // The textbook result: AIMD averages about three quarters of the link.
  const share = throughput(steady) / capacity;
  assert.ok(share > 0.7 && share < 0.8, String(share));
});

test("Reno keeps the link busier than Tahoe after losses", () => {
  const scenario = { ...base, rounds: 200, capacity: 30 };
  assert.ok(throughput(simulate({ ...scenario, variant: "Reno" })) > throughput(simulate({ ...scenario, variant: "Tahoe" })));
});

test("every round is consistent", () => {
  for (const variant of ["Tahoe", "Reno"] as const) {
    const r = simulate({ variant, rounds: 120, ssthresh: 32, capacity: 25, events: [{ round: 40, kind: "timeout" }] });
    for (const x of r) {
      assert.ok(x.cwnd >= 1 && x.ssthresh >= 2);
      assert.ok(x.delivered >= 0 && x.delivered <= Math.min(x.cwnd, 25));
      assert.equal(x.phase, x.cwnd < x.ssthresh ? "slow start" : "congestion avoidance");
      assert.ok(x.note.length > 0);
    }
  }
});

test("validation", () => {
  assert.throws(() => simulate({ ...base, rounds: 0 }), RangeError);
  assert.throws(() => simulate({ ...base, ssthresh: 1 }), RangeError);
  assert.throws(() => simulate({ ...base, capacity: 0 }), RangeError);
});

test("AIMD converges to a fair share: every loss halves the gap between two flows", () => {
  const steps = fairness(30, 2, 40, 300);
  const losses = steps.filter((s) => s.loss);
  for (let i = 1; i < losses.length; i++) {
    const before = losses[i - 1]!.a - losses[i - 1]!.b;
    const after = losses[i]!.a - losses[i]!.b;
    assert.ok(Math.abs(after - before / 2) < 1e-9, "the gap halves at each loss and is unchanged by increases");
  }
  const last = steps.at(-1)!;
  assert.ok(Math.abs(last.a - last.b) < 0.01, `${last.a} vs ${last.b}`);
});
