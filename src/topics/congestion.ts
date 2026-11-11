import { fairness, simulate, throughput, type LossKind, type Round, type Scenario, type Variant } from "../sim/congestion.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const W = 760;
const H = 300;
const PAD = { left: 44, right: 16, top: 14, bottom: 34 };

export const congestion: Topic = {
  id: "tcp-congestion",
  title: "TCP congestion control",
  area: "Networking",
  blurb: "Slow start, additive increase, multiplicative decrease: watch the congestion window find the link's capacity — and two flows find a fair share.",
  mount(root) {
    let variant: Variant = "Reno";
    let rounds: Round[] = [];
    let other: Round[] = [];

    const capacityInput = h("input", { type: "number", min: 4, max: 200, value: 24, "aria-label": "Link capacity" });
    const ssthreshInput = h("input", { type: "number", min: 2, max: 200, value: 32, "aria-label": "Initial ssthresh" });
    const roundsInput = h("input", { type: "number", min: 10, max: 120, value: 60, "aria-label": "Round trips" });
    const timeoutInput = h("input", { type: "number", min: 0, max: 120, value: 40, "aria-label": "Timeout at round (0 = none)" });
    const error = h("p", { class: "error", role: "alert" });
    const buttons = (["Tahoe", "Reno"] as Variant[]).map((v) => h("button", { type: "button", class: "segment", "aria-pressed": String(v === variant), onclick: () => {
      variant = v;
      run(player.index);
    } }, v));
    const chart = h("div", { class: "chart" });
    const legend = h("p", { class: "legend" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const stats = h("p", { class: "stats" });
    const player = createPlayer(draw, { label: "Step through the round trips" });
    for (const el of [capacityInput, ssthreshInput, roundsInput, timeoutInput]) el.addEventListener("change", () => run(player.index));

    // Fairness section
    const startA = h("input", { type: "number", min: 0, max: 100, value: 34, "aria-label": "Flow A starts at" });
    const startB = h("input", { type: "number", min: 0, max: 100, value: 2, "aria-label": "Flow B starts at" });
    const fairChart = h("div", { class: "chart square" });
    const fairNote = h("p", { class: "note", "aria-live": "polite" });
    let fairSteps = fairness(34, 2, 48, 80);
    const fairPlayer = createPlayer(drawFair, { label: "Step through the two flows" });
    for (const el of [startA, startB]) el.addEventListener("change", () => {
      fairSteps = fairness(clamp(Number(startA.value), 0, 100), clamp(Number(startB.value), 0, 100), 48, 80);
      fairPlayer.load(fairSteps.length, fairPlayer.index);
    });

    replace(root,
      h("h1", {}, "TCP congestion control"),
      prose("A TCP sender cannot see the network. It sees only what comes back: acknowledgements mean the path took what was sent; a missing one means a router somewhere dropped a packet because its queue was full. From that alone it must find how fast it can send — and share the link with everyone else doing the same. The *congestion window* (`cwnd`) is how many segments it lets be in flight per round trip; `ssthresh`, the *slow-start threshold*, is where fast growth gives way to careful growth. A *duplicate ACK* is the receiver repeating its last acknowledgement because a later segment arrived before the one it is waiting for. The *timeout at round* control injects one outage where nothing gets through, independent of the link's capacity."),
      h("div", { class: "controls" },
        h("div", { class: "segments", role: "group", "aria-label": "Variant" }, ...buttons),
        h("label", {}, "Link capacity ", capacityInput, " segments per round trip"),
        h("label", {}, "Initial ssthresh ", ssthreshInput),
        h("label", {}, "Round trips ", roundsInput),
        h("label", {}, "Timeout at round ", timeoutInput, " (0 = none)")),
      error,
      player.element,
      chart,
      legend,
      note,
      stats,
      h("h2", {}, "What the phases are"),
      h("ul", {},
        h("li", {}, prose("*Slow start* — despite the name, the fast part: every ACK adds a segment, so the window doubles every round trip. A new connection finds the right order of magnitude in a few RTTs.")),
        h("li", {}, prose("*Congestion avoidance* — past `ssthresh`, one segment more per round trip: *additive increase*, probing carefully for spare capacity.")),
        h("li", {}, prose("*Loss* — *multiplicative decrease*. Three duplicate ACKs mean packets still arrive and one is missing: Reno halves the window (*fast recovery*). A timeout means nothing arrives at all: every variant goes back to one segment. Tahoe, the older variant, treats both the same.")),
      ),
      h("h2", {}, "Two flows, one link: why AIMD is fair"),
      prose("Two senders share a link that carries 48 segments per round trip. Each runs AIMD: +1 per round trip, ×½ when the link overflows (both see the loss). Plot one window against the other. Additive increase moves the point diagonally — the *gap* between them stays the same. Multiplicative decrease moves it towards the origin — the gap halves. So, whatever the start, they end up sharing equally (Chiu and Jain, 1989). Try starting them far apart."),
      h("div", { class: "controls" }, h("label", {}, "Flow A starts at ", startA), h("label", {}, "Flow B starts at ", startB)),
      fairPlayer.element,
      fairChart,
      fairNote,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("Compare Tahoe and Reno on the same link — set the timeout to 0 first, so only the link's own losses count. How much more does Reno deliver once it is in the sawtooth, and why exactly?")),
        h("li", {}, prose("Set the initial ssthresh to 2: no slow start, and the connection crawls to the link's speed by +1 per round trip (round 24 instead of round 6). The default, 32, is already above the link, so slow start overshoots and loses at round 6; raising it further changes nothing, because doubling can never overshoot by more than 2×. (Real TCP would lose many segments in that overshoot; this model loses one.)")),
        h("li", {}, prose("Why multiplicative *decrease* but additive *increase*? Try the opposite in your head with the two-flow plot: would the gap ever shrink?")),
      ),
    );

    run();
    fairPlayer.load(fairSteps.length);
    return () => {
      player.destroy();
      fairPlayer.destroy();
    };

    function scenario(v: Variant): Scenario {
      const capacity = clamp(Number(capacityInput.value), 4, 200);
      const timeout = clamp(Number(timeoutInput.value), 0, 120);
      return {
        variant: v,
        rounds: clamp(Number(roundsInput.value), 10, 120),
        ssthresh: clamp(Number(ssthreshInput.value), 2, 200),
        capacity,
        events: timeout > 0 ? [{ round: timeout, kind: "timeout" as LossKind }] : [],
      };
    }

    function run(at = 0): void {
      try {
        rounds = simulate(scenario(variant));
        other = simulate(scenario(variant === "Reno" ? "Tahoe" : "Reno"));
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === variant)));
      player.load(rounds.length, Math.min(at, rounds.length - 1));
    }

    function draw(index: number): void {
      const cap = scenario(variant).capacity;
      const yMax = Math.max(cap * 1.3, ...rounds.map((r) => r.cwnd), ...rounds.map((r) => r.ssthresh)) + 2;
      const x = (round: number) => PAD.left + ((round - 1) / Math.max(1, rounds.length - 1)) * (W - PAD.left - PAD.right);
      const y = (v: number) => H - PAD.bottom - (v / yMax) * (H - PAD.top - PAD.bottom);
      const shown = rounds.slice(0, index + 1);
      const path = (rs: Round[], key: "cwnd" | "ssthresh") => rs.map((r, i) => `${i ? "L" : "M"}${x(r.round).toFixed(1)},${y(r[key]).toFixed(1)}`).join("");
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Congestion window over ${rounds.length} round trips` },
        ...axis(rounds.length, yMax, x, y),
        Number.isFinite(cap) ? s("line", { x1: PAD.left, x2: W - PAD.right, y1: y(cap), y2: y(cap), class: "capacity" }) : null,
        Number.isFinite(cap) ? s("text", { x: PAD.left + 6, y: y(cap) - 5, class: "label" }, `link capacity ${cap}`) : null,
        s("path", { d: path(other, "cwnd"), class: "ghost" }),
        s("path", { d: path(shown, "ssthresh"), class: "ssthresh" }),
        s("path", { d: path(shown, "cwnd"), class: "cwnd" }),
        ...shown.filter((r) => r.loss).map((r) => s("circle", { cx: x(r.round), cy: y(r.cwnd), r: 4.5, class: r.loss === "timeout" ? "loss timeout" : "loss" }, s("title", {}, `round ${r.round}: ${r.loss}`))),
        s("circle", { cx: x(rounds[index]!.round), cy: y(rounds[index]!.cwnd), r: 5, class: "now" }),
      );
      replace(chart, svg);
      replace(legend,
        h("span", { class: "key cwnd" }, `cwnd (${variant})`), h("span", { class: "key ssthresh" }, "ssthresh"),
        h("span", { class: "key ghost" }, `${variant === "Reno" ? "Tahoe" : "Reno"}, for comparison`),
        h("span", { class: "key loss" }, "loss: 3 duplicate ACKs"), h("span", { class: "key timeout" }, "timeout"));
      const r = rounds[index]!;
      note.textContent = `Round ${r.round}: cwnd ${r.cwnd}, ssthresh ${r.ssthresh}, ${r.phase}. ${r.note}`;
      const so = throughput(shown);
      replace(stats, `Delivered so far: ${so.toFixed(1)} segments per round trip on average${Number.isFinite(cap) ? ` — ${Math.round((100 * so) / cap)}% of the link` : ""}. Over the whole run: ${variant} ${throughput(rounds).toFixed(1)}, ${variant === "Reno" ? "Tahoe" : "Reno"} ${throughput(other).toFixed(1)}.`);
    }

    function drawFair(index: number): void {
      const C = 48;
      const size = 360;
      const pad = 40;
      const scale = (v: number) => pad + (v / 60) * (size - 2 * pad);
      const sy = (v: number) => size - scale(v);
      const shown = fairSteps.slice(0, index + 1);
      const svg = s("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "Window of flow A against flow B" },
        s("line", { x1: scale(0), y1: sy(0), x2: scale(60), y2: sy(0), class: "axis" }),
        s("line", { x1: scale(0), y1: sy(0), x2: scale(0), y2: sy(60), class: "axis" }),
        s("text", { x: scale(60), y: sy(0) + 26, class: "label end" }, "flow A window →"),
        s("text", { x: scale(0) - 8, y: sy(60) - 6, class: "label" }, "flow B ↑"),
        s("line", { x1: scale(0), y1: sy(0), x2: scale(60), y2: sy(60), class: "fair" }),
        s("text", { x: scale(52), y: sy(56), class: "label end" }, "fair: A = B"),
        s("line", { x1: scale(C), y1: sy(0), x2: scale(0), y2: sy(C), class: "capacity" }),
        s("text", { x: scale(C) + 4, y: sy(2), class: "label" }, `A + B = ${C}`),
        s("polyline", { points: shown.map((p) => `${scale(p.a).toFixed(1)},${sy(p.b).toFixed(1)}`).join(" "), class: "trajectory" }),
        s("circle", { cx: scale(shown.at(-1)!.a), cy: sy(shown.at(-1)!.b), r: 5, class: "now" }),
      );
      replace(fairChart, svg);
      const p = fairSteps[index]!;
      fairNote.textContent = `Round ${p.round}: A = ${fmt(p.a)}, B = ${fmt(p.b)}, gap ${fmt(Math.abs(p.a - p.b))}. ${p.loss ? `Together ${fmt(p.a + p.b)} > ${C}: both lose and halve — and so does the gap.` : "Both add one segment: the gap stays the same."}`;
    }
  },
};

function axis(n: number, yMax: number, x: (r: number) => number, y: (v: number) => number): SVGElement[] {
  const els: SVGElement[] = [
    s("line", { x1: PAD.left, x2: W - PAD.right, y1: H - PAD.bottom, y2: H - PAD.bottom, class: "axis" }),
    s("line", { x1: PAD.left, x2: PAD.left, y1: PAD.top, y2: H - PAD.bottom, class: "axis" }),
    s("text", { x: W - PAD.right, y: H - 6, class: "label end" }, "round trip →"),
  ];
  const yStep = niceStep(yMax / 5);
  for (let v = 0; v <= yMax; v += yStep) {
    els.push(s("line", { x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: PAD.left - 6, y: y(v) + 4, class: "label end" }, String(v)));
  }
  const xStep = niceStep(n / 8);
  for (let r = xStep; r <= n; r += xStep) els.push(s("text", { x: x(r), y: H - PAD.bottom + 16, class: "label middle" }, String(r)));
  return els;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? 10 * p;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
