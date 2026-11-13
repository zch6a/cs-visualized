import { ALGORITHMS, parseProcesses, schedule, type Algorithm, type Options, type Process, type Result } from "../sim/scheduling.ts";
import { h, keepInView, prose, replace } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const PRESETS: { name: string; text: string }[] = [
  { name: "Staggered arrivals", text: "P1 0 8\nP2 1 4\nP3 2 9\nP4 3 5" },
  { name: "The convoy", text: "P1 0 24\nP2 0 3\nP3 0 3" },
  { name: "Interactive vs batch", text: "batch 0 14\nui1 1 1\nui2 4 1\nui3 7 1\nui4 10 1" },
];

const EXPLAIN: Record<Algorithm, string> = {
  FCFS: "*First come, first served*: run processes in arrival order, each to completion. Fair in a queue-at-the-bank way — and one long job makes everyone behind it wait (the *convoy effect*).",
  SJF: "*Shortest job first*: when the CPU is free, run the waiting process with the shortest burst, to completion. When every job is already waiting, no non-interrupting order has a lower average wait. (With later arrivals it can do worse: a long job that just started blocks a short one that arrives a tick later.) And it needs the bursts in advance, which a real kernel does not know.",
  SRTF: "*Shortest remaining time first*: SJF that may interrupt. Whenever a process arrives, run whichever needs the least time *now*. Provably the lowest average waiting time of any policy — and long jobs can wait forever.",
  RR: "*Round robin*: every process gets a time slice (the *quantum*) in turn, then goes to the back of the queue. Nobody waits long for a first turn; everyone finishes later than they could.",
  MLFQ: "*Multi-level feedback queue*: several queues, the top one with the shortest slice. New processes start at the top; one that uses its whole slice is demoted. Short and interactive jobs stay on top without the scheduler knowing anything in advance — the idea behind real schedulers. A periodic *boost* back to the top keeps long jobs from starving.",
};

export const scheduling: Topic = {
  id: "scheduling",
  title: "CPU scheduling",
  area: "Operating systems",
  blurb: "First come first served, shortest job first, round robin and a multi-level feedback queue — on a Gantt chart, tick by tick.",
  mount(root) {
    let algorithm: Algorithm = "RR";
    let processes: Process[] = [];
    let result: Result | undefined;
    let levels: number[] = [2, 4]; // the MLFQ slices of the run on screen (declared before the first run)

    const procInput = h("textarea", { rows: 6, spellcheck: "false", "aria-label": "Processes: name, arrival time, burst", class: "procs" }, PRESETS[0]!.text);
    const quantumInput = h("input", { type: "number", min: 1, max: 20, value: 3, "aria-label": "Quantum" });
    const levelsInput = h("input", { type: "text", value: "2 4", "aria-label": "MLFQ slices per level", class: "short" });
    const boostInput = h("input", { type: "number", min: 0, max: 200, value: 0, "aria-label": "Boost period" });
    const rrOptions = h("label", {}, "Quantum ", quantumInput);
    const mlfqOptions = h("span", { class: "inline-options" }, h("label", {}, "Slices per level ", levelsInput), h("label", {}, "Boost every ", boostInput, " ticks (0 = never)"));
    const error = h("p", { class: "error", role: "alert" });
    const buttons = ALGORITHMS.map((a) => h("button", { type: "button", class: "segment", "aria-pressed": String(a === algorithm), onclick: () => {
      algorithm = a;
      run();
    } }, a));
    const explain = h("div", { class: "explain" });
    const gantt = h("div", { class: "gantt-scroll" });
    const queueView = h("div", { class: "queues" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const statsView = h("div", { class: "compare" });
    const compare = h("div", { class: "compare" });
    const player = createPlayer(draw, { label: "Step through the schedule" });
    for (const el of [procInput, quantumInput, levelsInput, boostInput]) el.addEventListener("change", () => run(player.index));

    replace(root,
      h("h1", {}, "CPU scheduling"),
      prose("More processes want the CPU than there are CPUs. (A process's *burst* is the CPU time it needs; to *preempt* is to take the CPU away from a process before it is done.) Every tick, the scheduler picks one of the ready processes to run. Pick well and short jobs finish fast and nobody starves; pick badly and a single long job holds everyone up. Each policy below is one answer to *who next?*"),
      h("div", { class: "controls stacked" },
        h("label", { class: "block" }, "Processes — name, arrival tick, CPU ticks needed:", procInput),
        h("div", { class: "presets" }, "Try: ", ...PRESETS.map((p) => h("button", { type: "button", class: "link", onclick: () => {
          procInput.value = p.text;
          run();
        } }, p.name))),
        h("div", { class: "segments", role: "group", "aria-label": "Scheduling policy" }, ...buttons),
        rrOptions, mlfqOptions),
      error,
      explain,
      player.element,
      gantt,
      queueView,
      note,
      h("h2", {}, "Per process"),
      prose("*Turnaround* = finish − arrival. *Waiting* = turnaround − CPU time: time spent ready but not running. *Response* = first run − arrival: how long before anything happened at all, which is what an interactive user feels."),
      statsView,
      h("h2", {}, "All policies on this workload"),
      compare,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("Load *The convoy* and compare FCFS with SJF: the same three jobs, average waiting 17 vs 3, only because of the order.")),
        h("li", {}, prose("In round robin, set the quantum to 1, then to 10 or more (longer than every job's CPU time). Watch average *response* and *turnaround* move in opposite directions — and see what a long quantum turns RR into.")),
        h("li", {}, prose("Load *Interactive vs batch* and switch between FCFS, RR and MLFQ: which one gives `ui2` to `ui4` a response time of 0? And why does `ui1` still wait a tick in MLFQ? (Then try SRTF.)")),
        h("li", {}, prose("Starvation: in MLFQ, give a long job and a stream of two-tick jobs (`long 0 6`, then `s1 2 2`, `s2 4 2`, … up to `s9 18 2` — the page takes ten processes). With boost 0 the long job waits from tick 2 until the stream ends at tick 20. With boost 8 it gets two ticks in every ten: a trickle, but no longer starved. Boost 4 gives it more — at what cost to the short jobs?")),
        h("li", {}, prose("SRTF has the lowest average waiting time in the table, always. Why does no real kernel use it? (What would it need to know?)")),
      ),
    );

    run();
    return () => player.destroy();

    function options(): Options {
      const levels = levelsInput.value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (levels.some((l) => !Number.isInteger(l) || l < 1) || levels.length < 1 || levels.length > 4) throw new RangeError("Slices per level: one to four whole numbers, e.g. \"2 4\".");
      const boost = Number(boostInput.value);
      if (!Number.isInteger(boost) || boost < 0 || boost > 200) throw new RangeError("Boost every: a whole number of ticks from 0 (never) to 200.");
      return { quantum: Number(quantumInput.value), levels, boost };
    }

    function run(at = 0): void {
      let opts: Options;
      // Parse and simulate into locals; the page's state changes only if everything is valid, so the
      // player can never draw a half-updated run.
      try {
        const procs = parseProcesses(procInput.value);
        if (procs.length > 10) throw new RangeError("At most 10 processes.");
        opts = options();
        const r = schedule(procs, algorithm, opts);
        if (r.ticks.length > 120) throw new RangeError("The schedule is longer than 120 ticks — shorten the bursts.");
        processes = procs;
        result = r;
        levels = opts.levels!;
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(ALGORITHMS[i] === algorithm)));
      rrOptions.hidden = algorithm !== "RR";
      mlfqOptions.hidden = algorithm !== "MLFQ";
      replace(explain, prose(EXPLAIN[algorithm]));
      player.load(result.ticks.length, Math.min(at, result.ticks.length - 1));
      drawComparison(opts);
    }

    function color(name: string | null): string {
      if (name === null) return "";
      return `c${processes.findIndex((p) => p.name === name) % 8}`;
    }

    function draw(index: number): void {
      const r = result!;
      const tick = r.ticks[index]!;
      // Gantt chart: one row per process, one cell per tick.
      const table = h("table", { class: "gantt" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...r.ticks.map((t) => h("th", { scope: "col", class: t.time === index ? "now" : "" }, String(t.time))))),
        h("tbody", {}, ...processes.map((p) => h("tr", {}, h("th", { scope: "row" }, p.name),
          ...r.ticks.map((t) => {
            const future = t.time > index;
            const ran = t.running === p.name && !future;
            const waiting = !future && !ran && t.time >= p.arrival && (r.stats[p.name]!.completion > t.time);
            return h("td", { class: [ran ? `run ${color(p.name)}` : waiting ? "wait" : "", t.time === index ? "now" : "", future ? "future" : "", t.time === p.arrival ? "arrive" : ""].join(" "), title: ran ? `${p.name} runs` : waiting ? `${p.name} waits` : "" });
          })))),
      );
      replace(gantt, table);
      replace(queueView, ...tick.queues.map((q, level) => h("div", { class: "queue" },
        h("span", { class: "queue-label" }, algorithm === "MLFQ" ? `queue ${level}${level < tick.queues.length - 1 ? ` (slice ${levels[level]})` : " (to completion)"}` : "ready queue"),
        ...(q.length ? q.map((n) => h("span", { class: `chip ${color(n)}` }, n, h("small", {}, ` ${tick.remaining[n]} left`))) : [h("span", { class: "empty" }, "empty")]))),
        h("div", { class: "queue" }, h("span", { class: "queue-label" }, "on the CPU"), tick.running ? h("span", { class: `chip ${color(tick.running)}` }, tick.running, h("small", {}, ` ${tick.remaining[tick.running]} left`)) : h("span", { class: "empty" }, "idle")));
      note.textContent = tick.note;
      const finishedBy = (name: string) => r.stats[name]!.completion <= index + 1;
      replace(statsView, h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, ...["process", "arrives", "needs", "finishes", "turnaround", "waiting", "response"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, ...processes.map((p) => {
          const s = r.stats[p.name]!;
          const done = finishedBy(p.name);
          return h("tr", {}, h("th", { scope: "row" }, h("span", { class: `swatch ${color(p.name)}` }), p.name), h("td", {}, String(p.arrival)), h("td", {}, String(p.burst)),
            ...[s.completion, s.turnaround, s.waiting].map((v) => h("td", {}, done ? String(v) : "…")),
            h("td", {}, index >= p.arrival + s.response ? String(s.response) : "…"));
        }),
        index === r.ticks.length - 1 ? h("tr", { class: "total" }, h("th", { scope: "row" }, "average"), h("td", {}), h("td", {}), h("td", {}),
          ...[r.average.turnaround, r.average.waiting, r.average.response].map((v) => h("td", {}, fmt(v)))) : null)));
      keepInView(gantt, gantt.querySelector("th.now"));
    }

    function drawComparison(opts: Options): void {
      const rows = ALGORITHMS.map((a) => ({ a, r: schedule(processes, a, opts) }));
      const best = (k: "waiting" | "turnaround" | "response") => Math.min(...rows.map((x) => x.r.average[k]));
      replace(compare, h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, ...["policy", "avg waiting", "avg turnaround", "avg response"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, ...rows.map(({ a, r }) => h("tr", { class: a === algorithm ? "chosen" : "" }, h("th", { scope: "row" }, a),
          ...(["waiting", "turnaround", "response"] as const).map((k) => h("td", { class: r.average[k] === best(k) ? "best" : "" }, fmt(r.average[k]))))))));
    }
  },
};

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}
