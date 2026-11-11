import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fnv1a, keyNames, load, moduloOwner, parseChanges, replay, Ring } from "../src/sim/hashing.ts";

const KEYS = keyNames(20000);
const SERVERS = ["A", "B", "C", "D", "E"];

test("the hash is deterministic and spreads names over the whole 32-bit range", () => {
  assert.equal(fnv1a("key-1"), fnv1a("key-1"));
  const hs = KEYS.slice(0, 5000).map(fnv1a);
  assert.ok(hs.every((h) => Number.isInteger(h) && h >= 0 && h < 2 ** 32));
  // Each quarter of the range gets about a quarter of the keys.
  for (let q = 0; q < 4; q++) {
    const share = hs.filter((h) => Math.floor(h / 2 ** 30) === q).length / hs.length;
    assert.ok(Math.abs(share - 0.25) < 0.03, `quarter ${q}: ${share}`);
  }
});

test("a key belongs to the first point clockwise, wrapping around", () => {
  const ring = new Ring(SERVERS, 3);
  const pts = ring.allPoints;
  for (const k of KEYS.slice(0, 500)) {
    const h = fnv1a(k);
    const expected = pts.find((p) => p.position >= h) ?? pts[0]!;
    assert.equal(ring.owner(k), expected.node);
  }
});

test("adding a server moves only keys to it — about 1/N of them, given enough virtual nodes", () => {
  const ring = new Ring(SERVERS, 200);
  const before = Object.fromEntries(KEYS.map((k) => [k, ring.owner(k)]));
  ring.add("F");
  const moved = KEYS.filter((k) => ring.owner(k) !== before[k]);
  assert.ok(moved.every((k) => ring.owner(k) === "F"), "every moved key moved to the new server");
  const share = moved.length / KEYS.length;
  assert.ok(Math.abs(share - 1 / 6) < 0.03, String(share));
});

test("removing a server moves only its own keys", () => {
  const ring = new Ring(SERVERS, 50);
  const before = Object.fromEntries(KEYS.map((k) => [k, ring.owner(k)]));
  ring.remove("C");
  for (const k of KEYS) if (before[k] !== "C") assert.equal(ring.owner(k), before[k]);
  assert.ok(KEYS.every((k) => ring.owner(k) !== "C"));
});

test("modulo placement moves almost everything when a server is added", () => {
  const moved = KEYS.filter((k) => moduloOwner(k, SERVERS) !== moduloOwner(k, [...SERVERS, "F"])).length / KEYS.length;
  // A key stays only if hash mod 5 = hash mod 6, which holds for 5 of every 30 residues: 1/6 stay.
  assert.ok(Math.abs(moved - 5 / 6) < 0.02, String(moved));
});

test("more virtual nodes even out the load", () => {
  const imbalance = (v: number) => load(KEYS, (k) => ringWith(v).owner(k), SERVERS).maxOverMean;
  const one = imbalance(1);
  const many = imbalance(200);
  assert.ok(one > 1.3, `one point per server: max/mean ${one}`);
  assert.ok(many < 1.1, `200 points per server: max/mean ${many}`);
  // The shares of the circle add up to 1.
  const shares = Object.values(new Ring(SERVERS, 7).shares());
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("replay: every step moves only what it must", () => {
  const steps = replay(["A", "B", "C"], parseChanges("add D, add E, remove B"), 100, keyNames(3000));
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.at(-1)!.nodes, ["A", "C", "D", "E"]);
  const [, addD, addE, removeB] = steps;
  assert.ok(addD!.moved.every((k) => addD!.owners[k] === "D"));
  assert.ok(addE!.moved.every((k) => addE!.owners[k] === "E"));
  assert.ok(removeB!.moved.every((k) => addE!.owners[k] === "B"));
  for (const s of steps.slice(1)) assert.ok(s.moved.length < s.movedModulo, s.note);
});

test("parsing and validation", () => {
  assert.deepEqual(parseChanges("add X\nremove A; add Y"), [{ kind: "add", node: "X" }, { kind: "remove", node: "A" }, { kind: "add", node: "Y" }]);
  assert.throws(() => parseChanges("grow X"), SyntaxError);
  assert.throws(() => new Ring(["A", "A"], 3), /already/);
  assert.throws(() => new Ring(["A"], 0), RangeError);
  assert.throws(() => new Ring(["A"], 3).remove("B"), /not on the ring/);
});

/** Build each ring once per vnode count. */
const rings = new Map<number, Ring>();
function ringWith(v: number): Ring {
  let r = rings.get(v);
  if (!r) rings.set(v, (r = new Ring(SERVERS, v)));
  return r;
}
