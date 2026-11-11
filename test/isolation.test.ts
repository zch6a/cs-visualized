import { strict as assert } from "node:assert";
import { test } from "node:test";

import { LEVELS, parseSchedule, run, SCENARIOS, type Level, type Op, type Schedule } from "../src/sim/isolation.ts";

const outcome = (name: keyof typeof SCENARIOS, level: Level) => run(parseSchedule(SCENARIOS[name].schedule), level);
const reads = (o: ReturnType<typeof run>, tx: string) => o.txs[tx]!.reads.map((r) => r.value);

test("dirty read: only Read Uncommitted shows a value that is later rolled back", () => {
  assert.deepEqual(reads(outcome("dirtyRead", "Read Uncommitted"), "T2"), [99]);
  for (const level of ["Read Committed", "Snapshot", "Serializable"] as const) assert.deepEqual(reads(outcome("dirtyRead", level), "T2"), [10], level);
  assert.equal(outcome("dirtyRead", "Read Uncommitted").serialOrder, null, "T2 saw a value no serial order produces");
});

test("non-repeatable read: Read Committed sees the change, a snapshot does not", () => {
  assert.deepEqual(reads(outcome("nonRepeatable", "Read Committed"), "T1"), [10, 20]);
  assert.deepEqual(reads(outcome("nonRepeatable", "Snapshot"), "T1"), [10, 10]);
  assert.equal(outcome("nonRepeatable", "Read Committed").serialOrder, null);
  assert.deepEqual(outcome("nonRepeatable", "Snapshot").serialOrder, ["T1", "T2"]);
});

test("lost update: Read Committed loses one increment; snapshot and serializable abort the second writer", () => {
  const rc = outcome("lostUpdate", "Read Committed");
  assert.equal(rc.final.x, 11, "two increments, one survives");
  assert.equal(rc.serialOrder, null);
  for (const level of ["Snapshot", "Serializable"] as const) {
    const o = outcome("lostUpdate", level);
    assert.equal(o.txs.T2!.status, "aborted", level);
    assert.match(o.txs.T2!.abortReason!, /first committer wins|stale/);
    assert.equal(o.final.x, 11);
    assert.deepEqual(o.serialOrder, ["T1"]);
  }
});

test("write skew: snapshot isolation lets both doctors go off call; serializable does not", () => {
  const si = outcome("writeSkew", "Snapshot");
  assert.equal(si.txs.T1!.status, "committed");
  assert.equal(si.txs.T2!.status, "committed");
  assert.deepEqual(si.final, { alice: 0, bob: 0 }, "nobody is on call — each transaction checked that the other was");
  assert.equal(si.serialOrder, null, "no serial order ends with both off call");
  const ser = outcome("writeSkew", "Serializable");
  assert.equal(ser.txs.T2!.status, "aborted");
  assert.deepEqual(ser.final, { alice: 0, bob: 1 });
  assert.deepEqual(ser.serialOrder, ["T1"]);
});

test("operations after a transaction ends are skipped; open transactions roll back", () => {
  const o = run(parseSchedule("init x=1\nT1 write x = 5\nT1 abort\nT1 commit\nT2 write x = 7"), "Read Committed");
  assert.ok(o.steps[2]!.skipped);
  assert.equal(o.txs.T2!.status, "aborted");
  assert.equal(o.final.x, 1);
});

test("Serializable always yields a serializable outcome; Snapshot never loses an update", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const schedule = randomSchedule(seed);
    const ser = run(schedule, "Serializable");
    assert.ok(ser.serialOrder !== null, `seed ${seed}: ${JSON.stringify(schedule.ops)}`);
    // First committer wins: no two committed transactions both wrote a key while overlapping.
    const si = run(schedule, "Snapshot");
    const committed = Object.keys(si.txs).filter((t) => si.txs[t]!.status === "committed");
    for (const key of ["x", "y"]) {
      const writers = committed.filter((t) => schedule.ops.some((o) => o.tx === t && o.kind === "write" && o.key === key));
      for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) assert.ok(!overlap(si.steps, writers[i]!, writers[j]!), `seed ${seed}: ${writers[i]} and ${writers[j]} both wrote ${key} concurrently`);
    }
  }
});

test("weaker levels do produce non-serializable outcomes on random schedules", () => {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (let seed = 1; seed <= 400; seed++) for (const level of LEVELS) if (run(randomSchedule(seed), level).serialOrder === null) counts[level]!++;
  assert.equal(counts.Serializable, 0);
  // Every weaker level produces some. (Not more and more as the level weakens: on these schedules, with
  // no aborts, a dirty read of a write that later commits often *looks* serial, so Read Uncommitted
  // scores fewer than Read Committed — the levels are defined by which anomalies they allow, not by how
  // often they occur.)
  assert.ok(counts["Read Uncommitted"]! > 0 && counts["Read Committed"]! > counts.Snapshot! && counts.Snapshot! > 0, JSON.stringify(counts));
});

test("parsing", () => {
  const s = parseSchedule("init a=1 b=-2\nT1 read a\nT1 write b = a + 3\nT2 write a = 7\nt2 commit  # comment");
  assert.deepEqual(s.initial, { a: 1, b: -2 });
  assert.deepEqual(s.ops[1], { tx: "T1", kind: "write", key: "b", expr: { key: "a", add: 3 } });
  assert.deepEqual(s.ops[2], { tx: "T2", kind: "write", key: "a", expr: { add: 7 } });
  assert.equal(s.ops[3]!.tx, "T2");
  assert.throws(() => parseSchedule("T1 frobnicate x"), SyntaxError);
  assert.throws(() => parseSchedule("T1 write x = y * 2"), SyntaxError);
  assert.throws(() => run(parseSchedule("T1 write x = y + 1"), "Snapshot"), /has not read/);
});

function overlap(steps: ReturnType<typeof run>["steps"], a: string, b: string): boolean {
  const span = (t: string) => {
    const idx = steps.filter((s) => s.op.tx === t && !s.skipped).map((s) => s.index);
    return [Math.min(...idx), Math.max(...idx)] as const;
  };
  const [a0, a1] = span(a);
  const [b0, b1] = span(b);
  return a0 < b1 && b0 < a1;
}

/** Three transactions over keys x and y: each reads one or two keys, writes one from a read value, and
 *  commits — interleaved at random. */
function randomSchedule(seed: number): Schedule {
  let r = seed * 2654435761 % 2 ** 31 || 1;
  const rand = (n: number) => ((r = (r * 48271) % 2147483647), r % n);
  const programs: Op[][] = ["T1", "T2", "T3"].map((tx) => {
    const first = rand(2) ? "x" : "y";
    const second = first === "x" ? "y" : "x";
    const ops: Op[] = [{ tx, kind: "read", key: first }];
    if (rand(2)) ops.push({ tx, kind: "read", key: second });
    const target = rand(2) ? first : second;
    if (!ops.some((o) => o.kind === "read" && o.key === target)) ops.push({ tx, kind: "read", key: target });
    ops.push({ tx, kind: "write", key: target, expr: { key: first, add: 1 + rand(3) } });
    ops.push({ tx, kind: "commit" });
    return ops;
  });
  const ops: Op[] = [];
  while (programs.some((p) => p.length)) {
    const live = programs.filter((p) => p.length);
    ops.push(live[rand(live.length)]!.shift()!);
  }
  return { initial: { x: 0, y: 0 }, ops };
}


test("Read Uncommitted returns the newest value, even when that is a commit after an open write", () => {
  // T1 writes 1 and stays open; T2 writes 2 and commits. The newest value is 2.
  const o = run(parseSchedule("init x=0\nT1 write x = 1\nT2 write x = 2\nT2 commit\nT3 read x\nT3 commit"), "Read Uncommitted");
  assert.deepEqual(reads(o, "T3"), [2]);
  const dirty = run(parseSchedule("init x=0\nT2 write x = 2\nT2 commit\nT1 write x = 1\nT3 read x\nT3 commit"), "Read Uncommitted");
  assert.deepEqual(reads(dirty, "T3"), [1], "an open write newer than every commit is what Read Uncommitted shows");
});

test("schedules are limited to a number of transactions the serializability check can search", () => {
  const seven = Array.from({ length: 7 }, (_, i) => `T${i + 1} read x`).join("\n");
  assert.throws(() => parseSchedule(seven), /at most 6 transactions/);
});