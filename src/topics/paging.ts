import { BELADY, countFaults, parseReferenceString, POLICIES, simulate, type PagingStep, type Policy } from "../sim/paging.ts";
import { h, prose, replace } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const PRESETS: { name: string; refs: string; frames: number }[] = [
  { name: "Textbook", refs: "7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1", frames: 3 },
  { name: "Belady's anomaly", refs: BELADY.join(" "), frames: 3 },
  { name: "A loop one page too big", refs: "1 2 3 4 1 2 3 4 1 2 3 4", frames: 3 },
];

const EXPLAIN: Record<Policy, string> = {
  FIFO: "*First in, first out*: evict the page that has been in memory longest. Simple, and blind to how pages are used.",
  LRU: "*Least recently used*: evict the page whose last use is furthest in the past — betting that the recent past predicts the near future.",
  OPT: "*Optimal* (Bélády's algorithm): evict the page whose next use is furthest in the future. It needs to know the future, so no kernel can run it — but it is the yardstick: no policy can fault less.",
  Clock: "*Clock* (second chance): frames sit on a circle with a *reference bit* each, set on every use. To evict, a hand sweeps the circle, clearing set bits and taking the first frame whose bit is already clear. LRU's idea at the cost of one bit per page — what real kernels approximate.",
};

export const paging: Topic = {
  id: "paging",
  title: "Page replacement",
  area: "Operating systems",
  blurb: "FIFO, LRU, Clock and the optimal policy, step by step — and the anomaly where more memory means more faults.",
  mount(root) {
    let refs = parseReferenceString(PRESETS[0]!.refs);
    let frames = PRESETS[0]!.frames;
    let policy: Policy = "LRU";
    let steps: PagingStep[] = [];

    const refsInput = h("input", { type: "text", value: PRESETS[0]!.refs, spellcheck: "false", "aria-label": "Reference string", class: "wide" });
    const framesInput = h("input", { type: "number", min: 1, max: 8, value: frames, "aria-label": "Frames" });
    const error = h("p", { class: "error", role: "alert" });
    const policyButtons = POLICIES.map((p) => h("button", { type: "button", class: "segment", "aria-pressed": String(p === policy), onclick: () => {
      policy = p;
      run(player.index);
    } }, p));
    const explain = h("div", { class: "explain" });
    const grid = h("div", { class: "grid-scroll" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const stats = h("p", { class: "stats" });
    const compare = h("div", { class: "compare" });
    const player = createPlayer(draw, { label: "Step through the reference string" });

    refsInput.addEventListener("change", () => run());
    framesInput.addEventListener("change", () => run());

    replace(root,
      h("h1", {}, "Page replacement"),
      prose("A program's pages do not all fit in memory. When it touches a page that is not there — a *page fault* — the operating system loads it from disk, and if memory is full, something else has to go. Which page to evict is the whole question, and a bad answer costs a disk read every time."),
      h("div", { class: "controls" },
        h("label", {}, "Pages referenced, in order ", refsInput),
        h("label", {}, "Frames of memory ", framesInput),
        h("div", { class: "segments", role: "group", "aria-label": "Policy" }, ...policyButtons),
        h("div", { class: "presets" }, "Try: ", ...PRESETS.map((p) => h("button", { type: "button", class: "link", onclick: () => {
          refsInput.value = p.refs;
          framesInput.value = String(p.frames);
          run();
        } }, p.name)))),
      error,
      explain,
      player.element,
      grid,
      note,
      stats,
      h("h2", {}, "Faults by policy and memory size"),
      prose("The same reference string with 1 to 8 frames. Read across a row: more memory should never mean more faults — and for LRU and OPT it never does (they are *stack algorithms*: what fits in n frames always fits in n + 1). FIFO has no such guarantee. Load *Belady's anomaly* and look at its row."),
      compare,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("Pick *A loop one page too big* and LRU: a loop over 4 pages in 3 frames faults on *every* reference — LRU always evicts exactly the page needed next. Now try OPT.")),
        h("li", {}, prose("Find a reference string where Clock and LRU disagree. (Hint: Clock only knows *whether* a page was used since the hand last passed, not *when*.)")),
        h("li", {}, prose("Why can no real kernel run OPT, and why do textbooks show it anyway?")),
      ),
    );

    run();
    return () => player.destroy();

    function run(at = 0): void {
      try {
        // Validate into locals first: a rejected input must leave the run on screen intact.
        const r = parseReferenceString(refsInput.value);
        const f = Number(framesInput.value);
        if (!Number.isInteger(f) || f < 1 || f > 8) throw new RangeError("Frames must be between 1 and 8.");
        if (r.length === 0) throw new RangeError("Enter at least one page number.");
        if (r.length > 60) throw new RangeError("At most 60 references, so the table stays readable.");
        refs = r;
        frames = f;
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      policyButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(POLICIES[i] === policy)));
      replace(explain, prose(EXPLAIN[policy]));
      steps = simulate(refs, frames, policy);
      player.load(steps.length, Math.min(at, steps.length - 1));
      drawComparison();
    }

    function draw(index: number): void {
      const current = steps[index]!;
      const table = h("table", { class: "paging" });
      const head = h("tr", {}, h("th", { scope: "col" }, "step"), ...steps.map((_, i) => h("th", { scope: "col", class: cellClass(i, index) }, String(i + 1))));
      const refRow = h("tr", {}, h("th", { scope: "row" }, "page"), ...steps.map((s, i) => h("td", { class: `ref ${cellClass(i, index)}` }, String(s.page))));
      const rows = Array.from({ length: frames }, (_, f) =>
        h("tr", {}, h("th", { scope: "row" }, `frame ${f}`), ...steps.map((s, i) => {
          if (i > index) return h("td", { class: "future" });
          const page = s.frames[f];
          const isNew = !s.hit && page === s.page && steps[i - 1]?.frames[f] !== page;
          const bit = s.refBits?.[f];
          const handHere = s.hand === f;
          return h("td", { class: [cellClass(i, index), isNew ? "loaded" : "", s.hit && page === s.page ? "hit" : ""].join(" ") },
            page === null || page === undefined ? "" : String(page),
            policy === "Clock" && page !== null ? h("sup", { class: bit ? "bit on" : "bit", title: bit ? "reference bit set" : "reference bit clear" }, bit ? "1" : "0") : null,
            policy === "Clock" && handHere && i === index ? h("span", { class: "hand", title: "the clock hand" }, "◀") : null);
        })));
      const result = h("tr", {}, h("th", { scope: "row" }, "result"), ...steps.map((s, i) =>
        h("td", { class: `result ${cellClass(i, index)}` }, i > index ? "" : s.hit ? "hit" : "fault")));
      table.append(h("thead", {}, head), h("tbody", {}, refRow, ...rows, result));
      replace(grid, table);
      note.textContent = current.note;
      const hits = index + 1 - current.faults;
      replace(stats, `${current.faults} faults, ${hits} hits so far — ${Math.round((100 * current.faults) / (index + 1))}% fault rate.`);
      grid.querySelector("th.now")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function cellClass(i: number, index: number): string {
      return i === index ? "now" : i > index ? "future" : "";
    }

    function drawComparison(): void {
      const sizes = Array.from({ length: 8 }, (_, i) => i + 1);
      const table = h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "frames →"), ...sizes.map((n) => h("th", { scope: "col", class: n === frames ? "chosen" : "" }, String(n))))),
        h("tbody", {}, ...POLICIES.map((p) => {
          const counts = sizes.map((n) => countFaults(refs, n, p));
          return h("tr", { class: p === policy ? "chosen" : "" }, h("th", { scope: "row" }, p), ...counts.map((c, i) => {
            const anomaly = i > 0 && c > counts[i - 1]!;
            return h("td", { class: [anomaly ? "anomaly" : "", sizes[i] === frames ? "chosen" : ""].join(" "), title: anomaly ? "more frames, more faults: Bélády's anomaly" : "" }, String(c), anomaly ? " ▲" : "");
          }));
        })));
      replace(compare, table);
    }
  },
};
