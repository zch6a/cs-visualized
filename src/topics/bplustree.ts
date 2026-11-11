import { build, parseKeys, type BPlusTree, type Step, type TreeSnapshot } from "../sim/bplustree.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const PRESETS = [
  { name: "1 to 20 in order", keys: Array.from({ length: 20 }, (_, i) => i + 1).join(" ") },
  { name: "Shuffled", keys: "15 3 22 8 41 1 30 12 5 27 19 36 9 44 2 33 25 17 6 38" },
  { name: "Descending", keys: Array.from({ length: 16 }, (_, i) => 16 - i).join(" ") },
];

const CELL = 26;
const NODE_H = 26;
const GAP = 14;
const LEVEL_H = 74;

export const bplustree: Topic = {
  id: "bplus-tree",
  title: "B+ tree",
  area: "Databases",
  blurb: "The index under almost every database table: watch keys go in, nodes split, the tree grow at the top — and a range scan walk the leaves.",
  mount(root) {
    let tree: BPlusTree;
    let steps: Step[] = [];
    let mode: "insert" | "search" | "range" = "insert";

    const orderInput = h("input", { type: "number", min: 3, max: 8, value: 4, "aria-label": "Order" });
    const keysInput = h("input", { type: "text", value: PRESETS[1]!.keys, class: "wide", spellcheck: "false", "aria-label": "Keys to insert" });
    const searchInput = h("input", { type: "number", value: 27, "aria-label": "Key to search for" });
    const loInput = h("input", { type: "number", value: 10, "aria-label": "Range from" });
    const hiInput = h("input", { type: "number", value: 26, "aria-label": "Range to" });
    const error = h("p", { class: "error", role: "alert" });
    const modeLine = h("p", { class: "stats" });
    const drawing = h("div", { class: "chart tree" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const player = createPlayer(draw, { label: "Step through the operation" });
    orderInput.addEventListener("change", () => rebuild());
    keysInput.addEventListener("change", () => rebuild());

    replace(root,
      h("h1", {}, "B+ tree"),
      prose("A database table can have millions of rows on disk, and reading from disk is slow — so an index must find a key by reading as few blocks as possible. A B+ tree does it in a handful: each node is one block holding many keys, so the tree is very wide and very shallow. Only the leaves hold the keys; the nodes above hold *separators* that say which way to go. The leaves are linked in order, so a range query is one descent and then a walk to the right."),
      h("div", { class: "controls" },
        h("label", {}, "Order ", orderInput, " (at most order − 1 keys per node)"),
        h("label", {}, "Insert, in order ", keysInput)),
      h("div", { class: "presets" }, "Try: ", ...PRESETS.map((p) => h("button", { type: "button", class: "link", onclick: () => {
        keysInput.value = p.keys;
        rebuild();
      } }, p.name))),
      h("div", { class: "controls" },
        h("button", { type: "button", onclick: () => rebuild() }, "Replay the inserts"),
        h("span", { class: "inline-options" }, h("label", {}, "Search for ", searchInput), h("button", { type: "button", onclick: () => doSearch() }, "Search")),
        h("span", { class: "inline-options" }, h("label", {}, "Range ", loInput), h("label", {}, "to ", hiInput), h("button", { type: "button", onclick: () => doRange() }, "Scan"))),
      error,
      modeLine,
      player.element,
      drawing,
      note,
      h("h2", {}, "Why databases use it"),
      h("ul", {},
        h("li", {}, prose("*Shallow.* With order 4 here, each node holds three keys. A real one holds hundreds — a 16 KB page of 8-byte keys — so four levels index billions of rows, and the top levels stay in memory.")),
        h("li", {}, prose("*Always balanced.* Splits push keys *up*, and only the root can add a level, so every leaf is at the same depth: no unlucky insertion order makes some lookups slow.")),
        h("li", {}, prose("*Range scans are cheap.* `WHERE id BETWEEN 10 AND 26` descends once and then reads leaves left to right, which is why the leaves are linked.")),
      ),
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("Insert *1 to 20 in order* with order 4 and look at the leaves: every split leaves its left half with 2 of 3 keys, and nothing will ever be inserted there again — the tree stays a third empty. That is why databases often split sequential inserts unevenly, keeping the left page full.")),
        h("li", {}, prose("Raise the order to 8 with the same keys. How much shallower is the tree?")),
        h("li", {}, prose("Search for a key that is not there: the search still reads exactly one node per level — a B+ tree cannot say no any faster than it says yes.")),
      ),
    );

    rebuild();
    return () => player.destroy();

    function rebuild(): void {
      try {
        const keys = parseKeys(keysInput.value);
        if (keys.length === 0) throw new RangeError("Enter some keys.");
        if (keys.length > 60) throw new RangeError("At most 60 keys, so the tree fits on screen.");
        const order = Number(orderInput.value);
        const result = build(order, keys);
        tree = result.tree;
        steps = result.steps;
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      mode = "insert";
      modeLine.textContent = `Building the tree: ${steps.length} steps for ${tree.size} keys. Height at the end: ${tree.height}.`;
      player.load(steps.length);
    }

    function doSearch(): void {
      const key = Number(searchInput.value);
      if (!Number.isInteger(key)) return;
      const r = tree.search(key);
      steps = r.steps;
      mode = "search";
      modeLine.textContent = `Searching for ${key}: ${r.found ? "found" : "not found"} after ${r.steps.at(-1)!.path.length} node reads.`;
      player.load(steps.length);
    }

    function doRange(): void {
      const lo = Number(loInput.value);
      const hi = Number(hiInput.value);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        error.textContent = "The range needs two whole numbers, low first.";
        return;
      }
      error.textContent = "";
      const r = tree.range(lo, hi);
      steps = r.steps;
      mode = "range";
      modeLine.textContent = `Range ${lo}–${hi}: ${r.keys.length} keys (${r.keys.join(", ") || "none"}).`;
      player.load(steps.length);
    }

    function draw(index: number): void {
      const step = steps[index]!;
      replace(drawing, renderTree(step.tree, step, mode));
      note.innerHTML = "";
      note.append(prose(step.note));
    }
  },
};

function renderTree(t: TreeSnapshot, step: Step, mode: string): SVGSVGElement {
  // Levels from the root down.
  const levels: number[][] = [];
  let frontier = [t.root];
  while (frontier.length) {
    levels.push(frontier);
    frontier = frontier.flatMap((id) => t.nodes[id]!.children ?? []);
  }
  const width = (id: number) => Math.max(1, t.nodes[id]!.keys.length) * CELL;
  // Leaves left to right; parents centred over their children.
  const x: Record<number, number> = {};
  let cursor = GAP;
  for (const id of levels.at(-1)!) {
    x[id] = cursor;
    cursor += width(id) + GAP;
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    for (const id of levels[l]!) {
      const kids = t.nodes[id]!.children!;
      const left = x[kids[0]!]!;
      const right = x[kids.at(-1)!]! + width(kids.at(-1)!);
      x[id] = (left + right) / 2 - width(id) / 2;
    }
  }
  const totalW = Math.max(cursor, 200);
  const totalH = levels.length * LEVEL_H;
  const y = (level: number) => 14 + level * LEVEL_H;
  const onPath = new Set(step.path);
  const created = new Set(step.created);
  const els: SVGElement[] = [];

  levels.forEach((ids, level) => {
    for (const id of ids) {
      const n = t.nodes[id]!;
      // Edges to children, from the gap between separators.
      n.children?.forEach((c, i) => {
        const fromX = x[id]! + i * CELL;
        const toX = x[c]! + width(c) / 2;
        els.push(s("line", { x1: fromX, y1: y(level) + NODE_H, x2: toX, y2: y(level + 1), class: `edge${onPath.has(id) && onPath.has(c) ? " on" : ""}` }));
      });
      // Leaf links.
      if (n.next !== undefined && x[n.next] !== undefined) {
        const x1 = x[id]! + width(id);
        const x2 = x[n.next]!;
        els.push(s("line", { x1: x1 + 2, y1: y(level) + NODE_H / 2, x2: x2 - 3, y2: y(level) + NODE_H / 2, class: `leaf-link${mode === "range" && onPath.has(id) ? " on" : ""}`, "marker-end": "url(#arrow)" }));
      }
    }
  });
  levels.forEach((ids, level) => {
    for (const id of ids) {
      const n = t.nodes[id]!;
      const cls = ["node", n.children ? "inner" : "leaf", onPath.has(id) ? "on" : "", created.has(id) ? "new" : ""].join(" ");
      const g = s("g", { class: cls });
      g.append(s("rect", { x: x[id]!, y: y(level), width: width(id), height: NODE_H, rx: 4 }));
      if (n.keys.length === 0) g.append(s("text", { x: x[id]! + CELL / 2, y: y(level) + 17, class: "key empty-key" }, "∅"));
      n.keys.forEach((k, i) => {
        if (i > 0) g.append(s("line", { x1: x[id]! + i * CELL, x2: x[id]! + i * CELL, y1: y(level), y2: y(level) + NODE_H, class: "divider" }));
        g.append(s("text", { x: x[id]! + i * CELL + CELL / 2, y: y(level) + 17, class: `key${k === step.key ? " hot" : ""}` }, String(k)));
      });
      els.push(g);
    }
  });
  return s("svg", { viewBox: `0 0 ${totalW} ${totalH}`, style: `max-width: ${Math.max(totalW, 320)}px`, role: "img", "aria-label": `B+ tree with ${levels.length} levels` },
    s("defs", {}, s("marker", { id: "arrow", viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto" }, s("path", { d: "M0,0 L6,3 L0,6 z", class: "arrowhead" }))),
    ...els);
}
