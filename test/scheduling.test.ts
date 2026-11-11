import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ALGORITHMS, parseProcesses, schedule, type Process } from "../src/sim/scheduling.ts";

const p = (name: string, arrival: number, burst: number): Process => ({ name, arrival, burst });
// The examples in Silberschatz et al., "Operating System Concepts", chapter 5.
const CONVOY = [p("P1", 0, 24), p("P2", 0, 3), p("P3", 0, 3)];
const SJF_EXAMPLE = [p("P1", 0, 6), p("P2", 0, 8), p("P3", 0, 7), p("P4", 0, 3)];
const SRTF_EXAMPLE = [p("P1", 0, 8), p("P2", 1, 4), p("P3", 2, 9), p("P4", 3, 5)];

const order = (r: ReturnType<typeof schedule>) => r.ticks.map((t) => t.running ?? "-").join(" ").replace(/(\S+)( \1)+/g, (m, x) => `${x}×${m.split(" ").length}`);

test("FCFS: the convoy effect (textbook: average wait 17, or 3 if the long job came last)", () => {
  assert.equal(schedule(CONVOY, "FCFS").average.waiting, 17);
  assert.equal(schedule([CONVOY[1]!, CONVOY[2]!, CONVOY[0]!], "FCFS").average.waiting, 3);
});

test("SJF: textbook average wait 7", () => {
  const r = schedule(SJF_EXAMPLE, "SJF");
  assert.equal(r.average.waiting, 7);
  assert.equal(order(r), "P4×3 P1×6 P3×7 P2×8");
});

test("SRTF: textbook average wait 6.5, with P1 preempted at t=1", () => {
  const r = schedule(SRTF_EXAMPLE, "SRTF");
  assert.equal(r.average.waiting, 6.5);
  assert.equal(order(r), "P1 P2×4 P4×5 P1×7 P3×9");
  assert.match(r.ticks[1]!.note, /preempt/);
});

test("round robin, quantum 4: textbook average wait 17/3", () => {
  const r = schedule(CONVOY, "RR", { quantum: 4 });
  assert.ok(Math.abs(r.average.waiting - 17 / 3) < 1e-9);
  assert.equal(order(r), "P1×4 P2×3 P3×3 P1×20");
});

test("round robin puts a newly arrived process ahead of the one whose slice just ended", () => {
  // A runs 0–2 (quantum 2); B arrives at 2. B must run before A gets its second slice.
  const r = schedule([p("A", 0, 4), p("B", 2, 2)], "RR", { quantum: 2 });
  assert.equal(order(r), "A×2 B×2 A×2");
});

test("MLFQ demotes CPU-bound work and lets short jobs through", () => {
  const r = schedule([p("long", 0, 20), p("short", 3, 2)], "MLFQ", { levels: [2, 4] });
  // long: 2 ticks in Q0, demoted; short arrives at 3 while long runs in Q1 → preempts it.
  assert.equal(r.ticks[3]!.running, "short");
  assert.equal(r.stats.short!.response, 0);
  assert.match(r.ticks[1]!.note, /down to queue 1/);
});

test("MLFQ boost stops starvation", () => {
  // A stream of short jobs keeps the top queue busy; without a boost the long job waits until they stop.
  const jobs = [p("long", 0, 6), ...Array.from({ length: 12 }, (_, i) => p(`s${i}`, 2 + 2 * i, 2))];
  const starved = schedule(jobs, "MLFQ", { levels: [2, 4] });
  const boosted = schedule(jobs, "MLFQ", { levels: [2, 4], boost: 8 });
  assert.ok(boosted.stats.long!.completion < starved.stats.long!.completion, `${boosted.stats.long!.completion} vs ${starved.stats.long!.completion}`);
});

test("idle CPU when nothing has arrived", () => {
  const r = schedule([p("A", 3, 2)], "FCFS");
  assert.deepEqual(r.ticks.map((t) => t.running), [null, null, null, "A", "A"]);
  assert.equal(r.stats.A!.waiting, 0);
});

test("invariants for every algorithm on random workloads", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const procs = randomWorkload(seed);
    const results = Object.fromEntries(ALGORITHMS.map((a) => [a, schedule(procs, a, { quantum: 3 })]));
    for (const [alg, r] of Object.entries(results)) {
      for (const proc of procs) {
        const ran = r.ticks.filter((t) => t.running === proc.name);
        assert.equal(ran.length, proc.burst, `${alg}: ${proc.name} gets exactly its burst`);
        assert.ok(ran.every((t) => t.time >= proc.arrival), `${alg}: never runs before arriving`);
        const s = r.stats[proc.name]!;
        assert.ok(s.waiting >= 0 && s.response >= 0 && s.response <= s.waiting + 0);
      }
      // Work-conserving: the CPU is never idle while a process is ready.
      for (const t of r.ticks) if (t.running === null) assert.equal(t.queues.flat().length, 0, `${alg} idle with work at t=${t.time}`);
    }
    // SRTF minimizes average waiting time; SJF is best among the non-preemptive ones here (FCFS).
    for (const a of ALGORITHMS) assert.ok(results.SRTF!.average.waiting <= results[a]!.average.waiting + 1e-9, `SRTF beaten by ${a}, seed ${seed}`);
    assert.ok(results.SJF!.average.waiting <= results.FCFS!.average.waiting + 1e-9);
  }
});

test("parsing and validation", () => {
  assert.deepEqual(parseProcesses("# name arrival burst\nP1 0 8\n  P2, 1, 4  \n"), [p("P1", 0, 8), p("P2", 1, 4)]);
  assert.throws(() => parseProcesses("P1 0"), /expected name, arrival time and burst/);
  assert.throws(() => parseProcesses("P1 x 3"), /whole numbers/);
  assert.throws(() => schedule([p("A", 0, 1), p("A", 0, 2)], "FCFS"), /unique/);
  assert.throws(() => schedule([p("A", 0, 0)], "FCFS"), /burst/);
  assert.throws(() => schedule([], "FCFS"), /no processes/);
});

function randomWorkload(seed: number): Process[] {
  let x = (seed * 7919) % 2147483647 || 1;
  const rand = (n: number) => ((x = (x * 48271) % 2147483647), x % n); // exact: products stay below 2^53
  return Array.from({ length: 3 + rand(5) }, (_, i) => p(`P${i + 1}`, rand(12), 1 + rand(9)));
}


test("MLFQ counts a slice across preemptions: an often-interrupted long job is still demoted", () => {
  // L uses 2 ticks in queue 0 (demoted), then is interrupted by a 1-tick job every other tick. It has
  // used its 4-tick slice of queue 1 by t=8 and must drop to queue 2 there.
  const r = schedule([p("L", 0, 12), p("a", 3, 1), p("b", 5, 1), p("c", 7, 1), p("d", 9, 1)], "MLFQ", { levels: [2, 4] });
  assert.match(r.ticks[8]!.note, /L used its whole slice: down to queue 2/);
  assert.equal(order(r), "L×3 a L b L c L d L×6");
});