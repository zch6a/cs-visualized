// A B+ tree: the index structure behind almost every database table.
//
// Keys live in the leaves, in order, and the leaves are linked left to right, so a range scan is one
// descent and then a walk along the leaves. Inner nodes hold only *separators* that steer the descent.
// Every node holds at most `order − 1` keys; when an insert overfills one, it splits in two and passes a
// key up to its parent — which may split in turn. When the root splits, the tree grows a level: B+ trees
// grow at the top, which is why every leaf is always at the same depth.
//
// Conventions (textbooks differ): a node with too many keys splits so that the left half gets the larger
// half (⌈n/2⌉ keys). A leaf split *copies* the right half's first key up (it stays in the leaf); an inner
// split *moves* its middle key up.

export interface NodeSnapshot {
  id: number;
  keys: number[];
  /** Inner nodes: child ids, one more than keys. Leaves: none. */
  children?: number[];
  /** Leaves: the next leaf to the right. */
  next?: number;
}

export interface TreeSnapshot {
  root: number;
  nodes: Record<number, NodeSnapshot>;
}

export interface Step {
  tree: TreeSnapshot;
  /** Nodes to highlight: the path taken, or the nodes just split. */
  path: number[];
  /** A key to highlight (the one being inserted or searched). */
  key: number | null;
  /** Nodes created by a split in this step. */
  created: number[];
  note: string;
}

interface Node {
  id: number;
  keys: number[];
  children: Node[] | null; // null = leaf
  next: Node | null;
}

export class BPlusTree {
  readonly order: number;
  private root: Node;
  private nextId = 0;
  size = 0;

  constructor(order: number) {
    if (!Number.isInteger(order) || order < 3 || order > 10) throw new RangeError("order must be a whole number from 3 to 10");
    this.order = order;
    this.root = this.node([], null);
  }

  private node(keys: number[], children: Node[] | null): Node {
    return { id: this.nextId++, keys, children, next: null };
  }

  get maxKeys(): number {
    return this.order - 1;
  }

  get height(): number {
    let h = 1;
    for (let n = this.root; n.children; n = n.children[0]!) h++;
    return h;
  }

  snapshot(): TreeSnapshot {
    const nodes: Record<number, NodeSnapshot> = {};
    const visit = (n: Node) => {
      nodes[n.id] = { id: n.id, keys: [...n.keys], ...(n.children ? { children: n.children.map((c) => c.id) } : {}), ...(n.next ? { next: n.next.id } : {}) };
      n.children?.forEach(visit);
    };
    visit(this.root);
    return { root: this.root.id, nodes };
  }

  /** Insert a key, recording each step (descent, insertion, every split). Duplicates are refused. */
  insert(key: number, steps: Step[] = []): Step[] {
    const path: Node[] = [];
    let n = this.root;
    while (n.children) {
      path.push(n);
      const i = childIndex(n.keys, key);
      n = n.children[i]!;
    }
    path.push(n);
    steps.push(this.step(path.map((p) => p.id), key, [], path.length > 1 ? `Insert ${key}: descend from the root, following the separators, to leaf [${n.keys.join(", ") || "empty"}].` : `Insert ${key} into the root, which is still a leaf.`));
    if (n.keys.includes(key)) {
      steps.push(this.step([n.id], key, [], `${key} is already in the tree: a primary-key index refuses duplicates.`));
      return steps;
    }
    n.keys.splice(sortedIndex(n.keys, key), 0, key);
    this.size++;
    if (n.keys.length <= this.maxKeys) {
      steps.push(this.step([n.id], key, [], `${key} fits in the leaf (${n.keys.length} of at most ${this.maxKeys} keys).`));
      return steps;
    }
    // Split upwards as long as nodes overflow.
    let child = n;
    for (let level = path.length - 1; child.keys.length > this.maxKeys; level--) {
      const parent = level > 0 ? path[level - 1]! : null;
      const { right, up, note } = this.split(child);
      if (parent) {
        const at = parent.children!.indexOf(child);
        parent.keys.splice(at, 0, up);
        parent.children!.splice(at + 1, 0, right);
        steps.push(this.step([child.id, right.id, parent.id], key, [right.id], `${note} ${up} goes up into the parent${parent.keys.length > this.maxKeys ? `, which now has ${parent.keys.length} keys — too many: it splits too` : ""}.`));
        child = parent;
      } else {
        this.root = this.node([up], [child, right]);
        steps.push(this.step([child.id, right.id, this.root.id], key, [right.id, this.root.id], `${note} The root itself split, so ${up} becomes a new root: the tree grows a level (height ${this.height}).`));
        break;
      }
    }
    return steps;
  }

  private split(n: Node): { right: Node; up: number; note: string } {
    const total = n.keys.length;
    const leftCount = Math.ceil(total / 2);
    if (!n.children) {
      const right = this.node(n.keys.slice(leftCount), null);
      n.keys = n.keys.slice(0, leftCount);
      right.next = n.next;
      n.next = right;
      return { right, up: right.keys[0]!, note: `The leaf has ${total} keys, one too many: it splits into [${n.keys.join(", ")}] and [${right.keys.join(", ")}], and a *copy* of ${right.keys[0]} — the right leaf's first key — becomes the separator.` };
    }
    // Inner node: the middle key moves up and is not kept below (left gets ⌊n/2⌋ keys, right the rest).
    const mid = Math.floor(total / 2);
    const up = n.keys[mid]!;
    const right = this.node(n.keys.slice(mid + 1), n.children.slice(mid + 1));
    n.keys = n.keys.slice(0, mid);
    n.children = n.children.slice(0, mid + 1);
    return { right, up, note: `The inner node has ${total} keys: it splits into [${n.keys.join(", ")}] and [${right.keys.join(", ")}], and its middle key ${up} *moves* up.` };
  }

  /** Look a key up, recording the path. */
  search(key: number, steps: Step[] = []): { found: boolean; steps: Step[] } {
    const path: number[] = [];
    let n = this.root;
    while (n.children) {
      path.push(n.id);
      const i = childIndex(n.keys, key);
      steps.push(this.step([...path], key, [], `At [${n.keys.join(", ")}]: ${describeChoice(n.keys, key, i)}.`));
      n = n.children[i]!;
    }
    path.push(n.id);
    const found = n.keys.includes(key);
    steps.push(this.step([...path], key, [], found ? `Leaf [${n.keys.join(", ")}] has ${key}: found after reading ${path.length} node${path.length > 1 ? "s" : ""} — the height of the tree.` : `Leaf [${n.keys.join(", ")}] does not have ${key}: it is not in the tree (and if it were, it would be here).`));
    return { found, steps };
  }

  /** All keys in [lo, hi]: one descent to the leaf where lo would be, then along the leaf links. */
  range(lo: number, hi: number, steps: Step[] = []): { keys: number[]; steps: Step[] } {
    const path: number[] = [];
    let n = this.root;
    while (n.children) {
      path.push(n.id);
      n = n.children[childIndex(n.keys, lo)]!;
    }
    path.push(n.id);
    steps.push(this.step([...path], lo, [], `Range ${lo}–${hi}: descend once, to the leaf where ${lo} would be.`));
    const keys: number[] = [];
    let reads = path.length; // the descent, including the first leaf
    for (let leaf: Node | null = n; leaf; leaf = leaf.next) {
      if (leaf !== n) reads++;
      const inRange = leaf.keys.filter((k) => k >= lo && k <= hi);
      keys.push(...inRange);
      const done = leaf.keys.some((k) => k > hi) || !leaf.next;
      steps.push(this.step([leaf.id], null, [], `Leaf [${leaf.keys.join(", ")}]: ${inRange.length ? `take ${inRange.join(", ")}` : "nothing in range"}. ${done ? `${leaf.next ? `A key above ${hi}: stop.` : "No more leaves: stop."} ${keys.length} keys in ${reads} node reads (${path.length} on the way down, then ${reads - path.length} more leaves).` : "Follow the link to the next leaf — no need to go back up the tree."}`));
      if (done) break;
    }
    return { keys, steps };
  }

  /** Every key, in order, by walking the leaf links. */
  keys(): number[] {
    let n = this.root;
    while (n.children) n = n.children[0]!;
    const out: number[] = [];
    for (let leaf: Node | null = n; leaf; leaf = leaf.next) out.push(...leaf.keys);
    return out;
  }

  private step(path: number[], key: number | null, created: number[], note: string): Step {
    return { tree: this.snapshot(), path, key, created, note };
  }
}

/** Which child to descend into: keys < separator[i] go left of it, keys ≥ it go right. */
function childIndex(separators: number[], key: number): number {
  let i = 0;
  while (i < separators.length && key >= separators[i]!) i++;
  return i;
}

function sortedIndex(keys: number[], key: number): number {
  let i = 0;
  while (i < keys.length && keys[i]! < key) i++;
  return i;
}

function describeChoice(keys: number[], key: number, i: number): string {
  if (i === 0) return `${key} < ${keys[0]}, so take the leftmost child`;
  if (i === keys.length) return `${key} ≥ ${keys[i - 1]}, so take the rightmost child`;
  return `${keys[i - 1]} ≤ ${key} < ${keys[i]}, so take child ${i + 1}`;
}

/** Build a tree from keys, returning every step. */
export function build(order: number, keys: readonly number[]): { tree: BPlusTree; steps: Step[] } {
  const tree = new BPlusTree(order);
  const steps: Step[] = [];
  for (const k of keys) tree.insert(k, steps);
  return { tree, steps };
}

export function parseKeys(text: string): number[] {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  return parts.map((p) => {
    if (!/^-?\d{1,4}$/.test(p)) throw new SyntaxError(`"${p}" is not a key (a whole number up to 4 digits)`);
    return Number(p);
  });
}
