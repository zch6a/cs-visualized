import { strict as assert } from "node:assert";
import { test } from "node:test";

import { BELADY, countFaults, parseReferenceString, POLICIES, simulate } from "../src/sim/paging.ts";

// The reference string used in Silberschatz et al., "Operating System Concepts".
const TEXTBOOK = [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1];

test("textbook fault counts with 3 frames", () => {
  // The values every OS course works out by hand: FIFO 15, LRU 12, OPT 9.
  assert.equal(countFaults(TEXTBOOK, 3, "FIFO"), 15);
  assert.equal(countFaults(TEXTBOOK, 3, "LRU"), 12);
  assert.equal(countFaults(TEXTBOOK, 3, "OPT"), 9);
});

test("Belady's anomaly: FIFO faults more with 4 frames than with 3", () => {
  assert.equal(countFaults(BELADY, 3, "FIFO"), 9);
  assert.equal(countFaults(BELADY, 4, "FIFO"), 10);
});

test("LRU and OPT are stack algorithms: more frames never means more faults", () => {
  for (const policy of ["LRU", "OPT"] as const) {
    for (const refs of [BELADY, TEXTBOOK, randomRefs(200, 9, 1), randomRefs(200, 6, 2)]) {
      for (let n = 1; n < 8; n++) assert.ok(countFaults(refs, n + 1, policy) <= countFaults(refs, n, policy), `${policy} n=${n}`);
    }
  }
});

test("OPT is optimal: no policy faults less", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const refs = randomRefs(150, 8, seed);
    for (let n = 1; n <= 6; n++) {
      const opt = countFaults(refs, n, "OPT");
      for (const policy of POLICIES) assert.ok(countFaults(refs, n, policy) >= opt, `${policy} beat OPT (seed ${seed}, ${n} frames)`);
    }
  }
});

test("Clock gives a second chance: with all reference bits set it behaves like FIFO", () => {
  // Each page referenced once, never again: every bit is set when the hand sweeps, so it clears them
  // all and evicts in loading order — FIFO.
  const refs = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(simulate(refs, 3, "Clock").map((s) => s.evicted), simulate(refs, 3, "FIFO").map((s) => s.evicted));
});

test("Clock spares a recently used page that FIFO evicts", () => {
  // 1 2 3 4: the hand sweeps once, clearing every bit, and 4 replaces 1. Then 2 is used again (its bit
  // is set), and 5 needs a frame: FIFO evicts 2, the oldest; Clock gives 2 a second chance and evicts 3.
  const refs = [1, 2, 3, 4, 2, 5];
  assert.equal(simulate(refs, 3, "FIFO").at(-1)!.evicted, 2);
  const clock = simulate(refs, 3, "Clock").at(-1)!;
  assert.equal(clock.evicted, 3);
  assert.ok(clock.frames.includes(2));
});

test("every step is consistent", () => {
  for (const policy of POLICIES) {
    const steps = simulate(TEXTBOOK, 3, policy);
    let faults = 0;
    steps.forEach((s, i) => {
      assert.equal(s.page, TEXTBOOK[i]);
      assert.ok(s.frames.includes(s.page), "the referenced page is in memory afterwards");
      assert.equal(new Set(s.frames.filter((f) => f !== null)).size, s.frames.filter((f) => f !== null).length, "no page twice");
      if (!s.hit) faults++;
      assert.equal(s.faults, faults);
      assert.equal(s.hit, i > 0 && steps[i - 1]!.frames.includes(s.page));
      if (s.evicted !== null) assert.ok(!s.frames.includes(s.evicted) || s.evicted === s.page);
      assert.ok(s.note.length > 0);
    });
  }
});

test("frame positions are stable: only the victim's frame changes", () => {
  const steps = simulate(TEXTBOOK, 4, "LRU");
  for (let i = 1; i < steps.length; i++) {
    const changed = steps[i]!.frames.filter((f, j) => f !== steps[i - 1]!.frames[j]).length;
    assert.ok(changed <= 1);
  }
});

test("parsing reference strings", () => {
  assert.deepEqual(parseReferenceString(" 7 0 1, 2,0  3 "), [7, 0, 1, 2, 0, 3]);
  assert.deepEqual(parseReferenceString(""), []);
  assert.throws(() => parseReferenceString("1 2 x"), /"x" is not a page number/);
  assert.throws(() => parseReferenceString("1 -2"), SyntaxError);
  assert.throws(() => simulate([1], 0, "FIFO"), RangeError);
});

function randomRefs(n: number, pages: number, seed: number): number[] {
  let x = seed * 2654435761;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % pages;
  });
}
