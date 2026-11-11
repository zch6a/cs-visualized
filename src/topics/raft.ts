import { parseEvents, simulate, type Frame, type InFlight } from "../sim/raft.ts";
import { h, prose, replace, s } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const PRESETS: { name: string; script: string; about: string }[] = [
  { name: "Elect a leader, replicate", script: "40 client x=1\n46 client y=2\n52 client x=3", about: "Nobody is leader at first. The first server whose randomized timeout runs out asks for votes; with a majority it leads, and replicates three client commands." },
  { name: "The leader crashes", script: "40 client a=1\n60 crash LEADER\n120 client b=2\n150 restart CRASHED", about: "The leader dies after one command. The others notice the silence, elect a new leader in a higher term, and the committed entry survives. The old leader comes back as a follower." },
  { name: "Split brain", script: "40 partition LEADER+MINORITY | REST\n46 client lost at LEADER\n110 client kept\n150 heal", about: "The network splits the leader, with as many servers as still make a minority, from the rest. The old leader keeps leading its side and accepts a write — but can never get it committed. The majority side elects its own leader and commits. When the network heals, the minority's entry is thrown away." },
  { name: "Catch up after a crash", script: "40 client p=1\n50 crash FOLLOWER\n56 client q=2\n62 client r=3\n70 crash LEADER\n120 restart CRASHED\n150 restart CRASHED", about: "A follower goes down after the first entry; two more are committed without it; then the leader dies too. The new leader assumes every follower is up to date, so when the first one comes back its AppendEntries are refused — and the leader backs up one entry at a time until the logs agree, then fills in the rest." },
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
      prose("Replicate a log over a few servers and you can lose some of them without losing data — if they agree on what the log says, in what order, even while crashing and while the network drops messages. Raft does it with a leader: servers elect one, the leader orders every client command and copies it to the others, and an entry is *committed* once the leader that created it has copied it to a majority (an entry from an older term counts only together with a newer one — see the rules below). Any majority overlaps any other, so a committed entry can never be lost."),
      h("div", { class: "presets" }, "Scenario: ", ...PRESETS.map((p) => h("button", { type: "button", class: "link", onclick: () => {
        scriptInput.value = p.script;
        rerun();
      } }, p.name))),
      about,
      h("details", {}, h("summary", {}, "Edit the events"),
        prose("One per line: `40 client x=1` (to the leader), `40 client x=1 at B`, `60 crash A`, `90 restart A`, `50 partition A B | C D E`, `120 heal`. Shorthand, resolved for each line at the moment its event happens: `LEADER` is whoever leads then, `FOLLOWER` the last live follower, `CRASHED` the server that has been down longest, `LEADER+MINORITY` the leader plus the next servers up to the largest minority, `REST` everyone else."),
        h("div", { class: "controls" }, h("label", {}, "Servers ", serversInput), h("label", {}, "Seed (election timeouts) ", seedInput)),
        scriptInput),
      error,
      player.element,
      h("div", { class: "split raft-split" }, picture, notes),
      h("h2", {}, "The logs"),
      prose("Each row is one server's log; the colour is the term in which the entry was created. A solid cell is committed on that server, an outlined one is not (yet). `no-op` is the blank entry each new leader starts its term with."),
      logs,
      h("h2", {}, "The rules that make it safe"),
      h("ul", {},
        h("li", {}, prose("*One vote per term*, and a server votes only for a candidate whose log is at least as up to date as its own — so whoever wins already holds every committed entry.")),
        h("li", {}, prose("*Randomized election timeouts*: servers rarely time out together, so one candidate usually wins quickly instead of everyone splitting the vote. (Here the timeouts are only 3–6 round trips long, so split votes are more common than in a real cluster, where they are about ten times the round trip.)")),
        h("li", {}, prose("*A higher term always wins*: a leader that sees a newer term steps down at once. That is what ends split brain when the network heals.")),
        h("li", {}, prose("*A new leader appends a no-op entry* at once. It is of the new term, so committing it commits everything before it — otherwise entries left over from the old leader would wait for the next client request, possibly forever.")),
        h("li", {}, prose("*Commit only entries of your own term by counting* (Figure 8 of the paper). An old-term entry can sit on a majority and still be overwritten by a later leader whose last entry has a newer term. With the no-op the rule rarely matters, since an older entry always travels with a current-term one; the tests turn the no-op off and stage Figure 8 to show the failure.")),
      ),
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("In *The leader crashes*, look for the election that fails: two candidates in the same term split the votes, nobody has a majority, and a later term decides. Randomized timeouts make this rare, not impossible.")),
        h("li", {}, prose("Change the seed: a different server wins the first election. Why must the protocol work whichever one it is?")),
        h("li", {}, prose("Crash three of five servers (`60 crash FOLLOWER` on three lines, at ticks 60, 61 and 62) and send `70 client z`: it can be appended, never committed. Add `110 restart CRASHED`: it commits.")),
        h("li", {}, prose("In *Split brain*, send a command to each side. Which one ends up in every log, and why can the other never be committed?")),
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
        // Resolve the shorthand line by line, in tick order: probe-run everything before the line, see who
        // leads, who follows and who crashed last, and substitute — for that line only.
        const TOKENS = /LEADER|FOLLOWER|CRASHED|REST/;
        const lines = scriptInput.value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        const tickOf = (l: string) => Number(l.split(/\s+/)[0]);
        const resolved: string[] = [];
        for (const line of lines) {
          const at = tickOf(line);
          if (Number.isInteger(at) && (at < 0 || at >= 200)) throw new RangeError(`"${line}": the run is 200 ticks long — use a tick from 0 to 199`);
        }
        for (const line of [...lines].sort((x, y) => tickOf(x) - tickOf(y))) {
          if (!TOKENS.test(line)) {
            resolved.push(line);
            continue;
          }
          const at = tickOf(line);
          if (!Number.isInteger(at) || at < 1 || at >= 200) throw new SyntaxError(`"${line}": the tick must be a whole number from 1 to 199`);
          const before = resolved.filter((l) => tickOf(l) < at);
          const probe = simulate({ servers: n, ticks: at, seed: Number(seedInput.value), events: parseEvents(before.join("\n")) }).at(-1)!;
          const live = probe.servers.filter((x) => x.alive);
          const leader = live.filter((x) => x.role === "leader").sort((x, y) => y.term - x.term)[0]?.id;
          // A real follower if there is one; otherwise (mid-election) any live server that is not the leader.
          const follower = (live.filter((x) => x.role === "follower").at(-1) ?? live.filter((x) => x.id !== leader).at(-1))?.id;
          // CRASHED: the server that has been down longest (crashes minus restarts, oldest first).
          const down: string[] = [];
          for (const l of before) {
            const m = l.match(/^\d+\s+(crash|restart)\s+([A-G])$/);
            if (m?.[1] === "crash" && !down.includes(m[2]!)) down.push(m[2]!);
            if (m?.[1] === "restart") down.splice(down.indexOf(m[2]!) >>> 0, down.includes(m[2]!) ? 1 : 0);
          }
          const crashed = down[0];
          const need = (name: string, value: string | undefined) => {
            if (!value) throw new RangeError(`"${line}": no ${name} at tick ${at} — move the event later`);
            return value;
          };
          let out = line;
          if (out.includes("LEADER+MINORITY")) {
            const l = need("leader", leader);
            const minority = Array.from({ length: Math.floor((n - 1) / 2) }, (_, i) => ids[(ids.indexOf(l) + i) % n]!);
            out = out.replace("LEADER+MINORITY", minority.join(" ")).replace("REST", ids.filter((x) => !minority.includes(x)).join(" "));
          }
          if (out.includes("LEADER")) out = out.replace(/LEADER/g, need("leader", leader));
          if (out.includes("FOLLOWER")) out = out.replace(/FOLLOWER/g, need("live follower", follower));
          if (out.includes("CRASHED")) out = out.replace(/CRASHED/g, need("crashed server", crashed));
          resolved.push(out);
        }
        const script = resolved.join("\n");
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
          h("th", { scope: "row" }, `${sv.id}${sv.role === "leader" && sv.alive ? " ★" : ""}`),
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
