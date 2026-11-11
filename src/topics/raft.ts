import { parseEvents, simulate, type Frame, type InFlight } from "../sim/raft.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const PRESETS: { name: string; script: string; about: string }[] = [
  { name: "Elect a leader, replicate", script: "40 client x=1\n46 client y=2\n52 client x=3", about: "Nobody is leader at first. The first server whose randomized timeout runs out asks for votes; with a majority it leads, and replicates three client commands." },
  { name: "The leader crashes", script: "40 client a=1\n60 crash LEADER\n120 client b=2\n150 restart LEADER", about: "The leader dies after one command. The others notice the silence, elect a new leader in a higher term, and the committed entry survives. The old leader comes back as a follower." },
  { name: "Split brain", script: "40 partition LEADER+MINORITY | REST\n46 client lost at LEADER\n110 client kept\n150 heal", about: "The network splits the leader, with as many servers as still make a minority, from the rest. The old leader keeps leading its side and accepts a write — but can never get it committed. The majority side elects its own leader and commits. When the network heals, the minority's entry is thrown away." },
  { name: "Catch up after a crash", script: "30 crash E\n40 client p=1\n46 client q=2\n90 restart E", about: "A follower is down while two entries are committed. When it restarts, the leader's AppendEntries back up until they find where E's log agrees, and fill it in." },
];

const SIZE = 380;
const C = SIZE / 2;
const R = 130;

export const raft: Topic = {
  id: "raft",
  title: "Raft consensus",
  area: "Distributed systems",
  blurb: "Five servers agree on one log while leaders crash and networks split: elections, replication, commitment — every message on the wire.",
  mount(root) {
    let frames: Frame[] = [];
    const serversInput = h("input", { type: "number", min: 3, max: 7, value: 5, "aria-label": "Servers" });
    const seedInput = h("input", { type: "number", min: 1, max: 9999, value: 1, "aria-label": "Seed" });
    const scriptInput = h("textarea", { rows: 5, class: "procs", spellcheck: "false", "aria-label": "Events" }, PRESETS[0]!.script);
    const about = h("div", { class: "explain" });
    const error = h("p", { class: "error", role: "alert" });
    const picture = h("div", { class: "chart raft-picture" });
    const logs = h("div", { class: "grid-scroll" });
    const notes = h("ul", { class: "notes", "aria-live": "polite" });
    const player = createPlayer(draw, { label: "Step through the ticks" });
    for (const el of [serversInput, seedInput, scriptInput]) el.addEventListener("change", () => rerun());

    replace(root,
      h("h1", {}, "Raft consensus"),
      prose("Replicate a log over a few servers and you can lose some of them without losing data — if they agree on what the log says, in what order, even while crashing and while the network drops messages. Raft does it with a leader: servers elect one, the leader orders every client command and copies it to the others, and an entry counts as *committed* once a majority has it. Any majority overlaps any other, so a committed entry can never be lost."),
      h("div", { class: "presets" }, "Scenario: ", ...PRESETS.map((p) => h("button", { type: "button", class: "link", onclick: () => {
        scriptInput.value = p.script;
        about.dataset.preset = p.name;
        rerun();
      } }, p.name))),
      about,
      h("details", {}, h("summary", {}, "Edit the events"),
        prose("One per line: `40 client x=1` (to the leader), `40 client x=1 at B`, `60 crash A`, `90 restart A`, `50 partition A B | C D E`, `120 heal`. `LEADER` means whoever leads when the event happens, `LEADER+MINORITY` the leader plus the next servers up to the largest minority, `REST` everyone else."),
        h("div", { class: "controls" }, h("label", {}, "Servers ", serversInput), h("label", {}, "Seed (election timeouts) ", seedInput)),
        scriptInput),
      error,
      player.element,
      h("div", { class: "split raft-split" }, picture, notes),
      h("h2", {}, "The logs"),
      prose("Each row is one server's log; the colour is the term in which the entry was created. A solid cell is committed on that server, an outlined one is not (yet)."),
      logs,
      h("h2", {}, "The rules that make it safe"),
      h("ul", {},
        h("li", {}, prose("*One vote per term*, and a server votes only for a candidate whose log is at least as up to date as its own — so whoever wins already holds every committed entry.")),
        h("li", {}, prose("*Randomized election timeouts*: servers rarely time out together, so one candidate usually wins quickly instead of everyone splitting the vote.")),
        h("li", {}, prose("*A higher term always wins*: a leader that sees a newer term steps down at once. That is what ends split brain when the network heals.")),
        h("li", {}, prose("*Commit only entries of your own term by counting* (Figure 8 of the paper). The tests here found the failure without it: in one random run of crashes and partitions, a server committed an old-term entry that a later leader overwrote.")),
      ),
    );

    rerun();
    return () => player.destroy();

    function rerun(): void {
      const preset = PRESETS.find((p) => p.script === scriptInput.value);
      replace(about, prose(preset ? `*${preset.name}.* ${preset.about}` : "Your own script."));
      try {
        const n = Number(serversInput.value);
        if (!Number.isInteger(n) || n < 3 || n > 7) throw new RangeError("Servers: 3 to 7.");
        const ids = ["A", "B", "C", "D", "E", "F", "G"].slice(0, n);
        // Resolve LEADER, LEADER+MINORITY and REST by probing: run up to that event and see who leads.
        let script = scriptInput.value;
        for (let pass = 0; pass < 5 && /LEADER|REST/.test(script); pass++) {
          const line = script.split("\n").find((l) => /LEADER|REST/.test(l))!;
          const at = Number(line.trim().split(/\s+/)[0]);
          if (!Number.isInteger(at) || at < 1 || at >= 200) throw new SyntaxError(`"${line.trim()}": the tick must be a whole number from 1 to 199`);
          const before = parseEvents(script.split("\n").filter((l) => !/LEADER|REST/.test(l) && Number(l.trim().split(/\s+/)[0]) < at).join("\n"));
          const probe = simulate({ servers: n, ticks: at, seed: Number(seedInput.value), events: before });
          const leader = probe.at(-1)!.servers.filter((x) => x.alive && x.role === "leader").sort((a, b) => b.term - a.term)[0]?.id;
          if (!leader) throw new RangeError(`"${line.trim()}": there is no leader yet at tick ${at} — move the event later`);
          // The largest minority containing the leader: ⌊(n − 1) / 2⌋ servers (2 of 5, 1 of 3 or 4).
          const minority = Array.from({ length: Math.floor((n - 1) / 2) }, (_, i) => ids[(ids.indexOf(leader) + i) % n]!);
          const rest = ids.filter((x) => !minority.includes(x));
          script = script.replace(line, line.replace("LEADER+MINORITY", minority.join(" ")).replace("REST", rest.join(" ")).replace(/LEADER/g, leader));
          script = script.replace(/LEADER/g, leader);
        }
        frames = simulate({ servers: n, ticks: 200, seed: Number(seedInput.value), events: parseEvents(script) });
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      player.load(frames.length);
    }

    function draw(index: number): void {
      const f = frames[index]!;
      const ids = f.servers.map((x) => x.id);
      const pos = (id: string) => {
        const a = (ids.indexOf(id) / ids.length) * 2 * Math.PI - Math.PI / 2;
        return [C + R * Math.cos(a), C + R * Math.sin(a)] as const;
      };
      const els: SVGElement[] = [];
      // Partition: shade the groups.
      if (f.groups) els.push(s("text", { x: C, y: SIZE - 10, class: "label middle partition-label" }, `partition: ${f.groups.map((g) => `{${g.join(" ")}}`).join("  ")}`));
      // Messages in flight, as dots travelling along the line between servers.
      for (const m of f.messages) els.push(messageDot(m, f.time));
      for (const sv of f.servers) {
        const [x, y] = pos(sv.id);
        const blocked = f.groups && !f.groups.some((g) => g.includes(sv.id) && g.length > f.servers.length / 2);
        els.push(s("g", { class: `server ${sv.role} ${sv.alive ? "" : "down"}` },
          s("circle", { cx: x, cy: y, r: 30 }),
          s("text", { x, y: y - 4, class: "server-name" }, sv.id),
          s("text", { x, y: y + 12, class: "server-term" }, sv.alive ? `term ${sv.term}` : "crashed"),
          s("text", { x, y: y + 46, class: "label middle" }, sv.alive ? `${sv.role}${sv.role === "candidate" ? ` (${sv.votes.length} votes)` : ""}${blocked ? " · minority" : ""}` : "")));
      }
      replace(picture, s("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img", "aria-label": "Servers and the messages between them" }, ...els));
      // The most recent events up to this tick, newest first.
      const recent = frames.slice(0, index + 1).flatMap((fr) => fr.notes.map((n) => ({ t: fr.time, n }))).slice(-8).reverse();
      replace(notes, h("li", { class: "notes-head" }, "What happened"), ...(recent.length ? recent : [{ t: f.time, n: "waiting for an election timeout" }]).map(({ t, n }) => h("li", { class: t === f.time ? "fresh" : "" }, `t=${t}: ${n}`)));

      const maxLen = Math.max(1, ...f.servers.map((x) => x.log.length));
      replace(logs, h("table", { class: "raft-logs" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...Array.from({ length: maxLen }, (_, i) => h("th", { scope: "col" }, String(i + 1))))),
        h("tbody", {}, ...f.servers.map((sv) => h("tr", { class: sv.alive ? "" : "down" },
          h("th", { scope: "row" }, `${sv.id}${sv.role === "leader" ? " ★" : ""}`),
          ...Array.from({ length: maxLen }, (_, i) => {
            const e = sv.log[i];
            if (!e) return h("td", {});
            return h("td", { class: `entry c${e.term % 8}${i < sv.commitIndex ? " committed" : ""}`, title: `term ${e.term}${i < sv.commitIndex ? ", committed" : ", not committed"}` }, e.command);
          }))))));

      function messageDot(m: InFlight, now: number): SVGElement {
        const [x1, y1] = pos(m.from);
        const [x2, y2] = pos(m.to);
        const frac = Math.min(1, (now - m.sent + 0.5) / (m.arrives - m.sent));
        const x = x1 + (x2 - x1) * frac;
        const y = y1 + (y2 - y1) * frac;
        const label = m.msg.type === "AppendEntries" ? (m.msg.entries.length ? `+${m.msg.entries.length}` : "♥") : m.msg.type === "RequestVote" ? "vote?" : m.msg.type === "Vote" ? (m.msg.granted ? "yes" : "no") : m.msg.success ? "ok" : "✗";
        return s("g", { class: `message ${m.msg.type}${m.dropped ? " dropped" : ""}` },
          s("line", { x1, y1, x2, y2, class: "wire" }),
          s("circle", { cx: x, cy: y, r: 9 }),
          s("text", { x, y: y + 3.5, class: "msg-label" }, label),
          s("title", {}, `${m.from} → ${m.to}: ${m.msg.type} (term ${m.msg.term})${m.dropped ? " — dropped" : ""}`));
      }
    }
  },
};
