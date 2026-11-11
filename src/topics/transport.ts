import { PROTOCOLS, simulate, type Config, type Frame, type Message, type Protocol, type Run } from "../sim/transport.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const EXPLAIN: Record<Protocol, string> = {
  "Go-Back-N": "*Go-Back-N*: the receiver keeps only data that arrives in order and answers every segment with a cumulative ACK — \"the next one I need is n\". When the sender's timer runs out, it goes back to the oldest unacknowledged segment and resends everything from there.",
  "Selective Repeat": "*Selective Repeat*: the receiver buffers segments that arrive out of order and acknowledges each one by itself; the sender keeps a timer per segment and resends only the ones whose timer expires.",
  TCP: "*TCP's way*: cumulative ACKs as in Go-Back-N, a receiver that buffers out-of-order data as in Selective Repeat, and one timer. Plus *fast retransmit*: every segment that arrives after a hole produces another ACK for the same number, and three of those duplicates say \"segment n is missing\" long before a timer would.",
};

export const transport: Topic = {
  id: "tcp-connection",
  title: "Reliable delivery",
  area: "Networking",
  blurb: "The TCP handshake, a sliding window, and three ways to recover lost packets — Go-Back-N, Selective Repeat and TCP's fast retransmit — on a sequence diagram.",
  mount(root) {
    let protocol: Protocol = "TCP";
    let run: Run | undefined;
    let cfg: Config;

    const num = (value: number, min: number, max: number, label: string) => h("input", { type: "number", min, max, value, "aria-label": label });
    const segInput = num(12, 1, 40, "Segments");
    const winInput = num(4, 1, 20, "Window");
    const delayInput = num(3, 1, 10, "One-way delay");
    const timeoutInput = num(14, 6, 100, "Timeout");
    const dropInput = h("input", { type: "text", value: "4", class: "short", "aria-label": "Data segments lost" });
    const dropAckInput = h("input", { type: "text", value: "", class: "short", "aria-label": "ACK numbers lost" });
    const rateInput = num(0, 0, 50, "Random loss percent");
    const seedInput = num(1, 1, 999, "Seed");
    const error = h("p", { class: "error", role: "alert" });
    const buttons = PROTOCOLS.map((p) => h("button", { type: "button", class: "segment", "aria-pressed": String(p === protocol), onclick: () => {
      protocol = p;
      rerun(player.index);
    } }, p));
    const explain = h("div", { class: "explain" });
    const windows = h("div", { class: "windows" });
    const diagram = h("div", { class: "chart sequence" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const compare = h("div", { class: "compare" });
    const player = createPlayer(draw, { label: "Step through time" });
    for (const el of [segInput, winInput, delayInput, timeoutInput, dropInput, dropAckInput, rateInput, seedInput]) el.addEventListener("change", () => rerun(player.index));

    replace(root,
      h("h1", {}, "Reliable delivery"),
      prose("The network may lose any packet. TCP still hands the application every byte, once, in order. It does so with three ideas: number everything, have the receiver say what it got (ACKs), and resend what was not acknowledged in time. A *sliding window* lets several segments be in flight at once, so the sender is not idle for a whole round trip after each one. The connection opens with a *handshake* (SYN, SYN-ACK, ACK: each side learns the other is there) and closes with FIN messages, one per direction. Segments are numbered from 0; a round trip is twice the one-way delay, and the timeout must be longer than that. (Real TCP numbers *bytes*, starting from a random number, and the numbers wrap around — which is why a Selective Repeat window may be at most half the number space. Here they never wrap.)"),
      h("div", { class: "controls" },
        h("div", { class: "segments", role: "group", "aria-label": "Protocol" }, ...buttons)),
      h("div", { class: "controls" },
        h("label", {}, "Segments ", segInput), h("label", {}, "Window ", winInput),
        h("label", {}, "One-way delay ", delayInput, " ticks"), h("label", {}, "Timeout ", timeoutInput, " ticks")),
      h("div", { class: "controls" },
        h("label", {}, "Lose data segments ", dropInput), h("label", {}, "Lose ACK numbers ", dropAckInput),
        h("label", {}, "Random loss ", rateInput, " %"), h("label", {}, "seed ", seedInput)),
      error,
      explain,
      player.element,
      windows,
      note,
      diagram,
      h("h2", {}, "The same losses, three protocols"),
      compare,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("Lose segment 4 and switch between the three protocols: Go-Back-N resends 4 and everything after it in the window; Selective Repeat resends 4 alone; TCP resends 4 alone and sooner — count the duplicate ACKs that trigger it.")),
        h("li", {}, prose("ACK numbers mean different things here: in Go-Back-N and TCP, ACK n means *the next segment I need is n*; in Selective Repeat, ACK n means *I got segment n*. Clear the data losses and lose ACK 3: Go-Back-N and TCP resend nothing — the next ACK covers it. Switch to Selective Repeat: segment 3 must be resent. Why?")),
        h("li", {}, prose("Set the window to 1: *stop-and-wait*. How much longer does the transfer take, and what does that say about a 100 ms round trip on a fast link?")),
        h("li", {}, prose("Set the timeout to exactly one round trip (6) and add random loss. Some resent segments are ones the server already had — from lost ACKs, and Go-Back-N's going back. Note that every message here takes exactly the same time, so a timer never fires *early*; real delays vary, which is why real TCP sets its timer to the measured round trip plus a margin, doubles it after every timeout, and never measures the round trip on a resent segment (Karn's rule).")),
      ),
    );

    rerun();
    return () => player.destroy();

    function list(input: HTMLInputElement): number[] {
      const parts = input.value.split(/[\s,]+/).filter(Boolean);
      if (parts.some((p) => !/^\d+$/.test(p))) throw new SyntaxError(`"${input.value}": whole numbers separated by spaces`);
      return parts.map(Number);
    }

    function config(p: Protocol): Config {
      return {
        protocol: p, segments: Number(segInput.value), window: Number(winInput.value), delay: Number(delayInput.value), timeout: Number(timeoutInput.value),
        dropData: list(dropInput), dropAcks: list(dropAckInput), lossRate: Number(rateInput.value) / 100, seed: Number(seedInput.value),
      };
    }

    function rerun(at = 0): void {
      try {
        cfg = config(protocol);
        run = simulate(cfg);
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(PROTOCOLS[i] === protocol)));
      replace(explain, prose(EXPLAIN[protocol]));
      player.load(run.frames.length, Math.min(at, run.frames.length - 1));
      drawCompare();
    }

    function draw(index: number): void {
      const frame = run!.frames[index]!;
      drawWindows(frame);
      drawDiagram(frame);
      note.textContent = frame.note;
    }

    function drawWindows(f: Frame): void {
      const N = cfg.segments;
      const sender = Array.from({ length: N }, (_, i) => {
        const state = f.acked[i] ? "acked" : i < f.next ? "inflight" : i < f.base + cfg.window ? "usable" : "later";
        return h("span", { class: `cell ${state}`, title: { acked: "acknowledged", inflight: "sent, not yet acknowledged", usable: "may be sent now", later: "outside the window" }[state] }, String(i));
      });
      const receiver = Array.from({ length: N }, (_, i) => {
        const state = f.delivered.includes(i) ? "acked" : f.buffered.includes(i) ? "buffered" : "later";
        return h("span", { class: `cell ${state}`, title: { acked: "delivered to the application", buffered: "buffered, waiting for a gap to fill", later: "not received yet" }[state] }, String(i));
      });
      replace(windows,
        h("div", { class: "strip" }, h("span", { class: "strip-label" }, `client window [${f.base}, ${f.base + cfg.window - 1}]`), ...sender),
        h("div", { class: "strip" }, h("span", { class: "strip-label" }, "server received"), ...receiver),
        h("p", { class: "legend" }, h("span", { class: "dot acked" }, "acknowledged / delivered"), h("span", { class: "dot inflight" }, "sent, unacknowledged"),
          h("span", { class: "dot usable" }, "may be sent"), h("span", { class: "dot buffered" }, "buffered out of order")));
    }

    function drawDiagram(f: Frame): void {
      const total = run!.frames.length;
      const W = 640;
      const px = 13;
      const top = 30;
      const H = top + total * px + 20;
      const cx = 150;
      const sx = W - 150;
      const y = (t: number) => top + t * px;
      const els: SVGElement[] = [
        s("text", { x: cx, y: 18, class: "label middle lane-name" }, "client"),
        s("text", { x: sx, y: 18, class: "label middle lane-name" }, "server"),
        s("line", { x1: cx, x2: cx, y1: top, y2: H - 10, class: "lane" }),
        s("line", { x1: sx, x2: sx, y1: top, y2: H - 10, class: "lane" }),
        s("line", { x1: 40, x2: W - 40, y1: y(f.time), y2: y(f.time), class: "now-line" }),
      ];
      for (let t = 0; t < total; t += 10) els.push(s("text", { x: 36, y: y(t) + 4, class: "label end" }, `t=${t}`));
      // Several messages can leave the same side in the same tick (an ACK and a segment): stack their labels.
      const stack = new Map<string, number>();
      for (const m of f.messages) {
        const key = `${m.from}@${m.sent}`;
        const k = stack.get(key) ?? 0;
        stack.set(key, k + 1);
        els.push(arrow(m, f.time, k));
      }
      replace(diagram, s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Sequence diagram of the messages so far" }, ...els));

      function arrow(m: Message, now: number, stacked: number): SVGElement {
        const [x1, x2] = m.from === "client" ? [cx, sx] : [sx, cx];
        const end = m.lost ? (m.sent + m.arrives) / 2 : m.arrives;
        const until = Math.min(now, end);
        const frac = (until - m.sent) / (m.arrives - m.sent);
        const xe = x1 + (x2 - x1) * frac;
        const ye = y(until);
        const kind = m.kind === "DATA" ? "data" : m.ack !== undefined ? "ack" : "control";
        const g = s("g", { class: `msg ${kind}${m.retransmission ? " again" : ""}${m.lost ? " lost" : ""}` },
          s("line", { x1, y1: y(m.sent), x2: xe, y2: ye }),
          s("title", {}, `${m.label}${m.retransmission ? " (retransmission)" : ""}: sent at t=${m.sent}${m.lost ? ", lost" : `, arrives at t=${m.arrives}`}`));
        if (now >= end && m.lost) g.append(s("text", { x: xe, y: ye + 4, class: "cross middle" }, "✕"));
        else if (now >= m.arrives) g.append(s("circle", { cx: x2, cy: y(m.arrives), r: 2.5 }));
        const lx = m.from === "client" ? x1 - 8 : x1 + 8;
        g.append(s("text", { x: lx, y: y(m.sent) + 4 + stacked * 11, class: `label ${m.from === "client" ? "end" : ""}` }, m.label + (m.retransmission ? " ↻" : "")));
        return g;
      }
    }

    function drawCompare(): void {
      // Each protocol on its own: one that cannot finish under these settings must not stop the others.
      const rows = PROTOCOLS.map((p) => {
        try {
          return { p, r: simulate(config(p)) };
        } catch {
          return { p, r: null };
        }
      });
      replace(compare, h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, ...["protocol", "segments sent", "of which resent", "closed at tick"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, ...rows.map(({ p, r }) => h("tr", { class: p === protocol ? "chosen" : "" }, h("th", { scope: "row" }, p),
          ...(r ? [h("td", {}, String(r.transmissions)), h("td", {}, String(r.retransmissions)), h("td", {}, String(r.finishedAt))]
            : [h("td", { colspan: 3, class: "anomaly" }, "did not finish within 5,000 ticks")]))))));
    }
  },
};
