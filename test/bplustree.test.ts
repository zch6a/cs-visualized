import { strict as assert } from "node:assert";
import { test } from "node:test";

import { BPlusTree, build, parseKeys, type TreeSnapshot } from "../src/sim/bplustree.ts";

/** Check every B+ tree invariant on a snapshot; returns the keys in leaf order. `midSplit` allows the
 *  one moment the page deliberately shows: a parent one key over the limit, about to split in turn. */
function check(t: TreeSnapshot, order: number, midSplit = false): number[] {
  const leafDepths = new Set<number>();
  const visit = (id: number, lo: number, hi: number, depth: number, isRoot: boolean): void => {
    const n = t.nodes[id]!;
    assert.ok(n.keys.length <= order - (midSplit ? 0 : 1), `node ${id} has ${n.keys.length} keys`);
    assert.deepEqual(n.keys, [...n.keys].sort((a, b) => a - b), "keys sorted");
    assert.ok(n.keys.every((k) => k >= lo && k < hi), `node ${id} keys ${n.keys} within [${lo}, ${hi})`);
    if (!n.children) {
      leafDepths.add(depth);
      if (!isRoot) assert.ok(n.keys.length >= Math.floor(order / 2), `leaf ${id} under-full`);
      return;
    }
    assert.equal(n.children.length, n.keys.length + 1);
    if (!isRoot) assert.ok(n.keys.length >= Math.ceil(order / 2) - 1, `inner ${id} under-full`);
    else assert.ok(n.keys.length >= 1);
    n.children.forEach((c, i) => visit(c, i === 0 ? lo : n.keys[i - 1]!, i === n.keys.length ? hi : n.keys[i]!, depth + 1, false));
  };
  visit(t.root, -Infinity, Infinity, 0, true);
  assert.equal(leafDepths.size, 1, "all leaves at the same depth");
  // Walk the leaf chain from the leftmost leaf.
  let id = t.root;
  while (t.nodes[id]!.children) id = t.nodes[id]!.children![0]!;
  const keys: number[] = [];
  for (let cur: number | undefined = id; cur !== undefined; cur = t.nodes[cur]!.next) keys.push(...t.nodes[cur]!.keys);
  return keys;
}

test("the first split, by this tree's convention", () => {
  // Order 3: at most 2 keys. Inserting 1, 2, 3 overfills the leaf: [1, 2] | [3], and 3 is copied up.
  const { tree } = build(3, [1, 2, 3]);
  const t = tree.snapshot();
  assert.deepEqual(t.nodes[t.root]!.keys, [3]);
  assert.deepEqual(t.nodes[t.root]!.children!.map((c) => t.nodes[c]!.keys), [[1, 2], [3]]);
});

test("an inner split moves the middle key up instead of copying it", () => {
  const { tree } = build(3, [1, 2, 3, 4, 5]);
  const t = tree.snapshot();
  // Leaves [1,2] [3] [4,5] would need separators 3, 4 — two keys, fine for order 3. Add 6 and 7:
  const more = build(3, [1, 2, 3, 4, 5, 6, 7]).tree.snapshot();
  const rootKeys = more.nodes[more.root]!.keys;
  const below = more.nodes[more.root]!.children!.flatMap((c) => more.nodes[c]!.keys);
  for (const k of rootKeys) assert.ok(!below.includes(k), `${k} moved up, it is not also in the inner level`);
  assert.equal(tree.height, 2);
  check(t, 3);
});

test("invariants hold after every single step, for many orders and insertion orders", () => {
  for (const order of [3, 4, 5, 6, 7]) {
    for (const keys of [ascending(60), descending(60), shuffled(80, order), shuffled(120, order * 7)]) {
      const { tree, steps } = build(order, keys);
      for (const s of steps) check(s.tree, order, true);
      const all = check(tree.snapshot(), order);
      assert.deepEqual(all, [...new Set(keys)].sort((a, b) => a - b), "the leaf chain is every key, in order");
      assert.equal(tree.size, new Set(keys).size);
    }
  }
});

test("height grows like a logarithm of the number of keys", () => {
  const { tree } = build(5, shuffled(1000, 3));
  // At most 4 keys and 5 children per node, at least half full: height between log5 and log3 of 1000.
  assert.ok(tree.height >= Math.ceil(Math.log(1000 / 4) / Math.log(5)) + 1 && tree.height <= Math.ceil(Math.log(1000) / Math.log(3)), String(tree.height));
});

test("search finds every key and nothing else, reading one node per level", () => {
  const keys = shuffled(200, 11).map((k) => k * 2); // even numbers only
  const { tree } = build(4, keys);
  for (const k of keys) {
    const r = tree.search(k);
    assert.ok(r.found, `finds ${k}`);
    assert.equal(r.steps.at(-1)!.path.length, tree.height);
  }
  for (const k of [1, 3, 99, -5, 1001]) assert.equal(tree.search(k).found, false);
});

test("range scans walk the leaf links", () => {
  const { tree } = build(4, shuffled(100, 5));
  assert.deepEqual(tree.range(10, 25).keys, Array.from({ length: 16 }, (_, i) => i + 10));
  assert.deepEqual(tree.range(95, 500).keys, [95, 96, 97, 98, 99]);
  assert.deepEqual(tree.range(-10, -1).keys, []);
  // One descent, then only leaves: no inner node is read twice.
  const r = tree.range(10, 60);
  assert.ok(r.steps.slice(1).every((s) => s.path.length === 1));
});

test("duplicates are refused", () => {
  const { tree, steps } = build(4, [5, 1, 5, 3]);
  assert.equal(tree.size, 3);
  assert.ok(steps.some((s) => /already in the tree/.test(s.note)));
});

test("parsing and validation", () => {
  assert.deepEqual(parseKeys("5, 1  3 -2"), [5, 1, 3, -2]);
  assert.throws(() => parseKeys("1 two"), /"two" is not a key/);
  assert.throws(() => new BPlusTree(2), RangeError);
});

function ascending(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
function descending(n: number): number[] {
  return ascending(n).reverse();
}
function shuffled(n: number, seed: number): number[] {
  const a = ascending(n);
  let x = seed * 2654435761 % 2 ** 31 || 1;
  for (let i = n - 1; i > 0; i--) {
    x = (x * 48271) % 2147483647;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
