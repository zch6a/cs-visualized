import { fnv1a, keyNames, load, moduloOwner, parseChanges, replay, Ring, type Step } from "../sim/hashing.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const NAMES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const KEYS = keyNames(2000);
const SHOWN = 240; // keys drawn on the ring
const SIZE = 420;
const C = SIZE / 2;
const R = 160;

export const hashing: Topic = {
  id: "consistent-hashing",
  title: "Consistent hashing",
  area: "Distributed systems",
  blurb: "Add a cache server and most keys stay put: servers and keys on one ring, virtual nodes for an even load — compared with hash mod N.",
  mount(root) {
    let steps: Step[] = [];
    let servers: string[] = [];

    const countInput = h("input", { type: "number", min: 2, max: 8, value: 4, "aria-label": "Servers at the start" });
    const vnodeInput = h("input", { type: "range", min: 1, max: 200, value: 1, "aria-label": "Points per server" });
    const vnodeLabel = h("span", { class: "mono" });
    const changesInput = h("input", { type: "text", value: "add E, add F, remove B", class: "wide", "aria-label": "Changes" });
    const error = h("p", { class: "error", role: "alert" });
    const ring = h("div", { class: "chart ring" });
    const loads = h("div", { class: "loads" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const balance = h("div", { class: "compare" });
    const player = createPlayer(draw, { label: "Step through the changes" });
    for (const el of [countInput, changesInput]) el.addEventListener("change", () => rerun());
    vnodeInput.addEventListener("input", () => rerun(player.index));

    replace(root,
      h("h1", {}, "Consistent hashing"),
      prose("A cache cluster spreads keys over servers. The simple rule — `server = hash(key) mod N` — works until N changes: add one server and almost every key now maps somewhere else, so almost every cached value is lost at once. *Consistent hashing* puts servers and keys on one circle of hash values; each key belongs to the first server clockwise from it. A new server takes over the arcs just before its points — with one point per server, a single arc from a single neighbour — and nothing else moves."),
      h("div", { class: "controls" },
        h("label", {}, "Servers at the start ", countInput),
        h("label", {}, "Points per server ", vnodeInput, vnodeLabel),
        h("label", {}, "Then ", changesInput)),
      error,
      player.element,
      h("div", { class: "split ring-split" }, ring, loads),
      note,
      h("h2", {}, "Why many points per server"),
      prose("With one point each, the arcs between servers are as uneven as random gaps usually are, and so is the load: one server can own twice its share. Give every server many points (*virtual nodes*) and each owns many small arcs, whose total is close to fair. Below: the busiest server's load relative to the average, for 2,000 keys. With so few keys, chance alone moves this by about 0.05–0.15 — compare the `hash mod N` column, which is perfectly uniform in principle — so read the trend, not every digit."),
      balance,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("With 1 point per server, step to *Add E* and compare the arc it takes with what the others keep. Now slide to 200 points and step to *Add E* again: how close to 1/N (here 1/5, 400 keys) does the moved share get?")),
        h("li", {}, prose("Remove a server: its keys go to the *next* server clockwise — with 1 point, all of them to one neighbour, which may double its load. With many points they scatter. Which matters more for a cache that is already at capacity?")),
        h("li", {}, prose("Dynamo, Cassandra and many caches use this. Why do they also give bigger machines *more* points?")),
      ),
    );

    rerun();
    return () => player.destroy();

    function rerun(at = 0): void {
      const vnodes = Number(vnodeInput.value);
      vnodeLabel.textContent = ` ${vnodes}`;
      try {
        servers = NAMES.slice(0, Number(countInput.value));
        const changes = parseChanges(changesInput.value);
        steps = replay(servers, changes, vnodes, KEYS);
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      player.load(steps.length, Math.min(at, steps.length - 1));
      drawBalance();
    }

    function colorOf(node: string): string {
      return `c${NAMES.indexOf(node) % 8}`;
    }

    function draw(index: number): void {
      const step = steps[index]!;
      const angle = (pos: number) => (pos / 2 ** 32) * 2 * Math.PI - Math.PI / 2;
      const at = (pos: number, r: number) => [C + r * Math.cos(angle(pos)), C + r * Math.sin(angle(pos))] as const;
      const els: SVGElement[] = [s("circle", { cx: C, cy: C, r: R, class: "ring-base" })];
      // Arcs: each point owns the arc from the previous point up to it.
      const pts = step.points;
      pts.forEach((p, i) => {
        const prev = pts[(i - 1 + pts.length) % pts.length]!.position;
        const span = (p.position - prev + 2 ** 32) % 2 ** 32 || 2 ** 32;
        const [x1, y1] = at(prev, R);
        const [x2, y2] = at(p.position, R);
        els.push(s("path", { d: `M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${span > 2 ** 31 ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)}`, class: `arc ${colorOf(p.node)}` }));
      });
      // Keys.
      const moved = new Set(step.moved);
      for (const k of KEYS.slice(0, SHOWN)) {
        const [x, y] = at(fnv1a(k), R - 22);
        els.push(s("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: moved.has(k) ? 3.6 : 2.2, class: `key-dot ${colorOf(step.owners[k]!)}${moved.has(k) ? " moved" : ""}` }, s("title", {}, `${k} → ${step.owners[k]}`)));
      }
      // Server points (labels only when there are few).
      const few = pts.length <= 40;
      for (const p of pts) {
        const [x, y] = at(p.position, R);
        els.push(s("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: few ? 6 : 2.5, class: `server-dot ${colorOf(p.node)}` }, s("title", {}, `${p.node}${p.replica ? ` #${p.replica}` : ""}`)));
        if (few) {
          const [lx, ly] = at(p.position, R + 18);
          els.push(s("text", { x: lx.toFixed(1), y: (ly + 4).toFixed(1), class: "label middle server-label" }, p.node));
        }
      }
      els.push(s("text", { x: C, y: C - 4, class: "label middle ring-center" }, `${step.nodes.length} servers`));
      els.push(s("text", { x: C, y: C + 14, class: "label middle" }, step.moved.length ? `${step.moved.length} keys moved` : "hash values 0 … 2³²"));
      replace(ring, s("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img", "aria-label": "The hash ring with servers and keys" }, ...els));

      const counts = Object.fromEntries(step.nodes.map((n) => [n, 0]));
      for (const k of KEYS) counts[step.owners[k]!]!++;
      const max = Math.max(...Object.values(counts));
      const mean = KEYS.length / step.nodes.length;
      replace(loads,
        h("h3", {}, "Keys per server"),
        ...step.nodes.map((n) => h("div", { class: "bar-row" },
          h("span", { class: "bar-label" }, n),
          h("span", { class: "bar-track" }, h("span", { class: `bar ${colorOf(n)}`, style: `width: ${(100 * counts[n]!) / max}%` })),
          h("span", { class: "bar-value" }, String(counts[n])))),
        h("p", { class: "stats" }, `average ${Math.round(mean)}, busiest ${(max / mean).toFixed(2)}× the average`),
        step.change ? h("p", { class: "stats" }, `this change moved ${step.moved.length} keys; hash mod N would have moved ${step.movedModulo}`) : null);
      replace(note, prose(step.note));
    }

    function drawBalance(): void {
      const counts = [1, 2, 5, 10, 50, 100, 200];
      const rows = counts.map((v) => {
        const r = new Ring(servers, v);
        return { v, ring: load(KEYS, (k) => r.owner(k), servers).maxOverMean };
      });
      const mod = load(KEYS, (k) => moduloOwner(k, servers), servers).maxOverMean;
      replace(balance, h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "points per server"), ...rows.map((r) => h("th", { scope: "col", class: r.v === Number(vnodeInput.value) ? "chosen" : "" }, String(r.v))), h("th", { scope: "col" }, "hash mod N"))),
        h("tbody", {}, h("tr", {}, h("th", { scope: "row" }, "busiest ÷ average"), ...rows.map((r) => h("td", { class: r.v === Number(vnodeInput.value) ? "chosen" : "" }, r.ring.toFixed(2))), h("td", {}, mod.toFixed(2))))));
    }
  },
};
