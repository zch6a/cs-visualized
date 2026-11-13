import { strict as assert } from "node:assert";
import { test } from "node:test";

import { NOOP, parseEvents, simulate, type Event, type Frame, type Server } from "../src/sim/raft.ts";

/** Client commands in a log, without the no-op entries each new leader appends. */
const commands = (s: Server) => s.log.map((e) => e.command).filter((c) => c !== NOOP);

const leaders = (f: Frame) => f.servers.filter((s) => s.alive && s.role === "leader");

/** The safety properties of the Raft paper (Figure 3), checked on every frame of a run. */
function checkSafety(frames: Frame[]): void {
  const leaderOfTerm = new Map<number, string>();
  const committed: { term: number; command: string }[] = [];
  for (const f of frames) {
    for (const s of f.servers) {
      // Election safety: at most one leader per term, ever.
      if (s.role === "leader") {
        const prev = leaderOfTerm.get(s.term);
        assert.ok(prev === undefined || prev === s.id, `t=${f.time}: two leaders in term ${s.term} (${prev}, ${s.id})`);
        leaderOfTerm.set(s.term, s.id);
      }
      assert.ok(s.commitIndex <= s.log.length, "cannot commit what you do not have");
      // Log terms never decrease along a log.
      for (let i = 1; i < s.log.length; i++) assert.ok(s.log[i]!.term >= s.log[i - 1]!.term);
    }
    // Log matching: same index and term ⇒ identical up to there.
    for (const a of f.servers) for (const b of f.servers) {
      const n = Math.min(a.log.length, b.log.length);
      for (let i = n - 1; i >= 0; i--) {
        if (a.log[i]!.term === b.log[i]!.term) {
          assert.deepEqual(a.log.slice(0, i + 1), b.log.slice(0, i + 1), `t=${f.time}: logs of ${a.id} and ${b.id} diverge before a matching entry`);
          break;
        }
      }
    }
    // State machine safety: a committed entry never changes, and every server agrees on it.
    for (const s of f.servers) {
      for (let i = 0; i < s.commitIndex; i++) {
        const e = s.log[i]!;
        if (committed[i] === undefined) committed[i] = { term: e.term, command: e.command };
        assert.deepEqual({ term: e.term, command: e.command }, committed[i], `t=${f.time}: ${s.id} committed a different entry at index ${i + 1}`);
      }
    }
  }
}

test("a leader is elected, and only one per term", () => {
  const frames = simulate({ servers: 5, ticks: 60, seed: 1 });
  const at = frames.findIndex((f) => leaders(f).length > 0);
  assert.ok(at > 0 && at < 40, `first leader at tick ${at}`);
  assert.equal(leaders(frames.at(-1)!).length, 1);
  checkSafety(frames);
});

test("client commands are replicated to every server and committed", () => {
  const events = parseEvents("40 client x=1\n45 client y=2\n50 client x=3");
  const frames = simulate({ servers: 5, ticks: 100, seed: 2, events });
  const last = frames.at(-1)!;
  for (const s of last.servers) {
    assert.deepEqual(commands(s), ["x=1", "y=2", "x=3"], s.id);
    assert.equal(s.commitIndex, s.log.length, `${s.id} has learned the commit index`);
  }
  checkSafety(frames);
});

test("when the leader crashes, the others elect a new one in a higher term and keep the log", () => {
  const first = simulate({ servers: 5, ticks: 40, seed: 3 });
  const leader = leaders(first.at(-1)!)[0]!;
  const events: Event[] = [{ at: 40, kind: "client", command: "a" }, { at: 60, kind: "crash", server: leader.id }, { at: 110, kind: "client", command: "b" }];
  const frames = simulate({ servers: 5, ticks: 160, seed: 3, events });
  const after = leaders(frames.at(-1)!);
  assert.equal(after.length, 1);
  assert.notEqual(after[0]!.id, leader.id);
  assert.ok(after[0]!.term > leader.term);
  assert.deepEqual(commands(after[0]!), ["a", "b"], "the committed entry survives the leader");
  checkSafety(frames);
});

test("a leader cut off in a minority cannot commit; after healing, its uncommitted entry is replaced", () => {
  const first = simulate({ servers: 5, ticks: 40, seed: 4 });
  const old = leaders(first.at(-1)!)[0]!.id;
  const others = ["A", "B", "C", "D", "E"].filter((x) => x !== old);
  const minority = [old, others[0]!];
  const majority = others.slice(1);
  const events: Event[] = [
    { at: 40, kind: "partition", groups: [minority, majority] },
    { at: 45, kind: "client", command: "lost", to: old },
    { at: 110, kind: "client", command: "kept" },
    { at: 140, kind: "heal" },
  ];
  const frames = simulate({ servers: 5, ticks: 220, seed: 4, events });
  const during = frames[130]!;
  const stale = during.servers.find((s) => s.id === old)!;
  assert.equal(stale.log.at(-1)?.command, "lost");
  assert.ok(stale.commitIndex < stale.log.length, "two servers out of five are not a majority: \"lost\" stays uncommitted");
  const end = frames.at(-1)!;
  for (const s of end.servers) assert.deepEqual(commands(s), ["kept"], `${s.id}: "lost" was never committed and is gone`);
  checkSafety(frames);
});

test("a restarted server catches up from its peers", () => {
  const events = parseEvents("30 crash E\n40 client p\n45 client q\n80 restart E");
  const frames = simulate({ servers: 5, ticks: 140, seed: 5, events });
  const e = frames.at(-1)!.servers.find((s) => s.id === "E")!;
  assert.deepEqual(commands(e), ["p", "q"]);
  assert.equal(e.commitIndex, e.log.length);
  checkSafety(frames);
});

test("safety holds under random crashes, restarts and partitions", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const events = randomEvents(seed);
    const frames = simulate({ servers: 5, ticks: 300, seed, events });
    checkSafety(frames);
  }
});

test("the Figure 8 rule: only entries of the leader's own term are committed by counting replicas", () => {
  // Figure 8 of the paper, staged with the no-op turned off. (With the no-op, every message carrying an
  // older entry also carries a current-term entry, so the rule never decides anything; and random
  // fault schedules almost never hit this timing — 0 of 3,000 do.) Each event is placed after the run
  // so far has reached the state the next one needs; later events never change earlier frames.
  const events: Event[] = [];
  const run = (ticks = 400) => simulate({ servers: 5, ticks, seed: 8, events, noop: false });
  const first = (from: number, ok: (f: Frame) => boolean) => {
    const at = run().findIndex((f) => f.time > from && ok(f));
    assert.ok(at >= 0, `the run never reached the next stage after tick ${from}: ${JSON.stringify(events)}`);
    return run()[at]!;
  };
  const server = (f: Frame, id: string) => f.servers.find((s) => s.id === id)!;

  // (a) Leader L1, cut off with one follower P, takes "x" at index 1 — two copies, not a majority.
  let f = first(-1, (fr) => leaders(fr).length > 0);
  const l1 = leaders(f)[0]!.id;
  const [p, ...rest] = ["A", "B", "C", "D", "E"].filter((x) => x !== l1);
  events.push({ at: f.time + 1, kind: "partition", groups: [[l1, p!], rest] }, { at: f.time + 2, kind: "client", command: "x", to: l1 });
  // (b) The other three elect L2, which takes "y" at index 1 alone in a later term, then crashes.
  f = first(f.time + 2, (fr) => leaders(fr).some((s) => rest.includes(s.id)) && server(fr, p!).log.length === 1);
  const l2 = leaders(f).find((s) => rest.includes(s.id))!.id;
  const [q, r] = rest.filter((x) => x !== l2);
  events.push(
    { at: f.time + 1, kind: "partition", groups: [[l1, p!], [l2], [q!, r!]] },
    { at: f.time + 2, kind: "client", command: "y", to: l2 },
    { at: f.time + 3, kind: "crash", server: l2 },
    { at: f.time + 4, kind: "heal" },
  );
  // (c) L1 or P wins a still later term and copies "x" to Q and R: now on a majority, but from an old term.
  f = first(f.time + 4, (fr) => leaders(fr).some((s) => s.id === l1 || s.id === p) && [q!, r!].every((id) => server(fr, id).log[0]?.command === "x"));
  const l3 = leaders(f)[0]!;
  assert.equal(l3.log[0]!.term < l3.term, true, '"x" is from an older term than the leader that spread it');
  // (d) L2 comes back on the side of Q and R; its "y" has a newer term than "x", so they elect it.
  events.push({ at: f.time + 1, kind: "partition", groups: [[l1, p!], [l2, q!, r!]] }, { at: f.time + 1, kind: "restart", server: l2 });
  const frames = run();
  const end = frames.at(-1)!;
  assert.deepEqual([q!, r!].map((id) => server(end, id).log[0]!.command), ["y", "y"], "L2 overwrote x on Q and R — legal only because x was never committed");
  assert.ok(frames.every((fr) => fr.servers.every((s) => s.commitIndex === 0)), "nothing could be committed: no leader ever had an entry of its own term on a majority");
  checkSafety(frames);
});

test("three servers tolerate one failure, not two", () => {
  const one = simulate({ servers: 3, ticks: 150, seed: 6, events: parseEvents("40 crash A\n41 crash B\n90 client z") });
  // With two of three down nobody can win an election: no leader, and the command fails.
  assert.equal(leaders(one.at(-1)!).length, 0);
  assert.ok(one.some((f) => f.notes.some((n) => /there is no leader/.test(n))));
});

test("parsing", () => {
  assert.deepEqual(parseEvents("10 crash A\n20 partition A B | C D E\n30 heal\n40 client x=1 at B"), [
    { at: 10, kind: "crash", server: "A" },
    { at: 20, kind: "partition", groups: [["A", "B"], ["C", "D", "E"]] },
    { at: 30, kind: "heal" },
    { at: 40, kind: "client", command: "x=1", to: "B" },
  ]);
  assert.throws(() => parseEvents("10 explode A"), /unknown action/);
  assert.throws(() => parseEvents("10 partition A B"), SyntaxError);
  assert.throws(() => simulate({ servers: 3, ticks: 10, seed: 1, delay: 5, electionTimeout: [8, 9] }), RangeError);
});

function randomEvents(seed: number): Event[] {
  let r = (seed * 7919) % 2147483647 || 1;
  const rand = (n: number) => ((r = (r * 48271) % 2147483647), r % n);
  const ids = ["A", "B", "C", "D", "E"];
  const events: Event[] = [];
  for (let t = 20; t < 280; t += 5 + rand(15)) {
    const k = rand(10);
    if (k < 4) events.push({ at: t, kind: "client", command: `c${t}` });
    else if (k < 6) events.push({ at: t, kind: "crash", server: ids[rand(5)]! });
    else if (k < 8) events.push({ at: t, kind: "restart", server: ids[rand(5)]! });
    else if (k === 8) {
      const shuffled = [...ids].sort(() => rand(3) - 1);
      const cut = 1 + rand(4);
      events.push({ at: t, kind: "partition", groups: [shuffled.slice(0, cut), shuffled.slice(cut)] });
    } else events.push({ at: t, kind: "heal" });
  }
  return events;
}


test("a single server is its own majority; other cluster sizes stay safe", () => {
  const one = simulate({ servers: 1, ticks: 80, seed: 1, events: parseEvents("40 client x=1") });
  const s = one.at(-1)!.servers[0]!;
  assert.equal(s.role, "leader");
  assert.equal(s.commitIndex, s.log.length, "nobody else to ask: the entry is committed at once");
  for (const servers of [2, 3, 4, 6, 7]) {
    for (let seed = 1; seed <= 10; seed++) {
      const ids = ["A", "B", "C", "D", "E", "F", "G"].slice(0, servers);
      const events = randomEvents(seed).filter((e) => (e.kind !== "crash" && e.kind !== "restart") || ids.includes(e.server)).filter((e) => e.kind !== "partition");
      checkSafety(simulate({ servers, ticks: 250, seed, events }));
    }
  }
});

test("events naming a server that does not exist are refused clearly", () => {
  assert.throws(() => simulate({ servers: 3, ticks: 50, seed: 1, events: parseEvents("10 crash D") }), /no server D/);
  assert.throws(() => simulate({ servers: 3, ticks: 50, seed: 1, events: parseEvents("10 partition A | E") }), /no server E/);
});

test("a new leader commits earlier entries through its no-op, without waiting for a client", () => {
  // The catch-up scenario sends nothing after the second leader takes over. Without the no-op, entry
  // r=3 (from the old term) stayed uncommitted forever on some seeds; now it commits on every seed.
  for (let seed = 1; seed <= 8; seed++) {
    const first = simulate({ servers: 5, ticks: 40, seed });
    const leader = first.at(-1)!.servers.find((s) => s.role === "leader")!.id;
    const follower = ["A", "B", "C", "D", "E"].filter((x) => x !== leader).at(-1)!;
    const events = parseEvents(`40 client p=1\n50 crash ${follower}\n56 client q=2\n62 client r=3\n70 crash ${leader}\n120 restart ${follower}\n150 restart ${leader}`);
    const end = simulate({ servers: 5, ticks: 220, seed, events }).at(-1)!;
    for (const s of end.servers) {
      assert.deepEqual(commands(s), ["p=1", "q=2", "r=3"], `seed ${seed}, ${s.id}`);
      assert.equal(s.commitIndex, s.log.length, `seed ${seed}, ${s.id}: everything committed`);
    }
  }
});

test("a seed below 1 is refused instead of giving election timeouts shorter than a round trip", () => {
  for (const seed of [0, -1, 1.5]) assert.throws(() => simulate({ servers: 5, ticks: 10, seed, events: [] }), /seed/, String(seed));
  assert.equal(simulate({ servers: 5, ticks: 200, seed: 1, events: [] }).at(-1)!.servers.filter((s) => s.role === "leader").length, 1);
});
