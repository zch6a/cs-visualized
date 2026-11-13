// Raft: how a few servers agree on one log even when some crash or the network splits.
//
// Following the paper (Ongaro and Ousterhout, 2014), reduced to its core: leader election with
// randomized timeouts, log replication with AppendEntries, and commitment by majority. Time moves in
// ticks; every message takes `delay` ticks; crashed servers and messages across a partition are dropped.
// The run is deterministic for a given seed, so every interleaving can be replayed and tested.
//
// Left out: snapshots, membership changes, client sessions, and pre-vote.

export type Role = "follower" | "candidate" | "leader";

export interface Entry {
  term: number;
  command: string;
}

export interface Server {
  id: string;
  role: Role;
  term: number;
  votedFor: string | null;
  log: Entry[];
  /** Highest log index known to be committed (1-based; 0 = none). */
  commitIndex: number;
  alive: boolean;
  /** Tick at which a follower/candidate starts an election if it hears nothing. */
  electionDeadline: number;
  votes: string[];
  /** Leader only: next index to send and highest index known replicated, per follower. */
  nextIndex: Record<string, number>;
  matchIndex: Record<string, number>;
}

export type Message =
  | { type: "RequestVote"; term: number; lastLogIndex: number; lastLogTerm: number }
  | { type: "Vote"; term: number; granted: boolean }
  | { type: "AppendEntries"; term: number; prevIndex: number; prevTerm: number; entries: Entry[]; leaderCommit: number }
  | { type: "AppendReply"; term: number; success: boolean; matchIndex: number };

export interface InFlight {
  id: number;
  from: string;
  to: string;
  sent: number;
  arrives: number;
  msg: Message;
  /** Dropped on delivery (crashed endpoint or partition). */
  dropped?: boolean;
}

export type Event =
  | { at: number; kind: "client"; command: string; to?: string }
  | { at: number; kind: "crash"; server: string }
  | { at: number; kind: "restart"; server: string }
  | { at: number; kind: "partition"; groups: string[][] }
  | { at: number; kind: "heal" };

export interface Config {
  servers: number;
  ticks: number;
  seed: number;
  delay?: number;
  electionTimeout?: [number, number];
  heartbeat?: number;
  events?: Event[];
  /** Whether a new leader appends a no-op entry of its term (default true). Turning it off is how the
   *  tests show that the Figure 8 rule is needed: with the no-op, every message that carries older
   *  entries also carries a current-term entry after them, so the rule never gets to decide anything. */
  noop?: boolean;
}

export interface Frame {
  time: number;
  servers: Server[];
  messages: InFlight[];
  groups: string[][] | null;
  notes: string[];
}

const NAMES = ["A", "B", "C", "D", "E", "F", "G"];

/** The command of a leader's first entry in its term. */
export const NOOP = "no-op";

export function simulate(c: Config): Frame[] {
  if (!Number.isInteger(c.servers) || c.servers < 1 || c.servers > 7) throw new RangeError("servers must be 1 to 7");
  if (!Number.isInteger(c.ticks) || c.ticks < 1 || c.ticks > 2000) throw new RangeError("ticks must be 1 to 2000");
  // A seed of 0 or below made the generator return negative numbers: election timeouts shorter than a
  // round trip, and with seed −1 no leader in 200 ticks.
  if (!Number.isInteger(c.seed) || c.seed < 1) throw new RangeError("seed must be a whole number from 1");
  const delay = c.delay ?? 2;
  const [tMin, tMax] = c.electionTimeout ?? [12, 24];
  const heartbeat = c.heartbeat ?? 4;
  if (tMin <= 2 * delay || tMax < tMin) throw new RangeError("the election timeout must exceed a round trip");
  let seed = (c.seed * 2654435761) % 2147483647 || 1;
  const random = () => ((seed = (seed * 48271) % 2147483647), seed / 2147483647);
  const timeout = (now: number) => now + tMin + Math.floor(random() * (tMax - tMin + 1));

  const ids = NAMES.slice(0, c.servers);
  const majority = Math.floor(ids.length / 2) + 1;
  for (const e of c.events ?? []) {
    const named = e.kind === "crash" || e.kind === "restart" ? [e.server] : e.kind === "partition" ? e.groups.flat() : e.kind === "client" && e.to ? [e.to] : [];
    const unknown = named.filter((n) => !ids.includes(n));
    if (unknown.length) throw new RangeError(`tick ${e.at}: there is no server ${unknown.join(", ")} (servers are ${ids.join(", ")})`);
  }
  const servers: Server[] = ids.map((id) => ({
    id, role: "follower", term: 0, votedFor: null, log: [], commitIndex: 0, alive: true,
    electionDeadline: timeout(0), votes: [], nextIndex: {}, matchIndex: {},
  }));
  const byId = (id: string) => servers.find((s) => s.id === id)!;
  let flight: InFlight[] = [];
  let nextMessage = 0;
  let groups: string[][] | null = null;
  const frames: Frame[] = [];
  const lastHeartbeat: Record<string, number> = {};
  const connected = (a: string, b: string) => !groups || groups.some((g) => g.includes(a) && g.includes(b));
  const lastTerm = (s: Server) => s.log.at(-1)?.term ?? 0;

  for (let t = 0; t < c.ticks; t++) {
    const notes: string[] = [];
    // 1. Scripted events.
    for (const e of c.events ?? []) {
      if (e.at !== t) continue;
      if (e.kind === "crash") {
        const s = byId(e.server);
        if (s.alive) {
          s.alive = false;
          notes.push(`${s.id} crashes${s.role === "leader" ? " — the leader is gone" : ""}`);
        }
      } else if (e.kind === "restart") {
        const s = byId(e.server);
        if (!s.alive) {
          // Term, vote and log are on disk and survive; everything else starts over.
          Object.assign(s, { alive: true, role: "follower", commitIndex: 0, votes: [], nextIndex: {}, matchIndex: {}, electionDeadline: timeout(t) });
          notes.push(`${s.id} restarts as a follower, with its term (${s.term}) and log (${s.log.length} entries) from disk`);
        }
      } else if (e.kind === "partition") {
        groups = e.groups;
        notes.push(`the network splits: ${e.groups.map((g) => `{${g.join(" ")}}`).join(" | ")}`);
      } else if (e.kind === "heal") {
        groups = null;
        notes.push("the network heals");
      } else {
        const leaders = servers.filter((s) => s.alive && s.role === "leader" && (!e.to || s.id === e.to)).sort((a, b) => b.term - a.term);
        const leader = leaders[0];
        if (leader) {
          leader.log.push({ term: leader.term, command: e.command });
          leader.matchIndex[leader.id] = leader.log.length;
          advanceCommit(leader, notes); // a cluster of one is its own majority
          notes.push(`a client sends "${e.command}" to ${leader.id}, which appends it at index ${leader.log.length} (term ${leader.term}) — not committed yet`);
        } else notes.push(`a client sends "${e.command}", but ${e.to ? `${e.to} is not a leader` : "there is no leader"}: the request fails and must be retried`);
      }
    }
    // 2. Deliver messages.
    const arriving = flight.filter((m) => m.arrives === t);
    flight = flight.filter((m) => m.arrives > t);
    for (const m of arriving) {
      const to = byId(m.to);
      if (!to.alive || !byId(m.from).alive || !connected(m.from, m.to)) {
        m.dropped = true;
        continue;
      }
      receive(to, m, t, notes);
    }
    // 3. Timers.
    for (const s of servers) {
      if (!s.alive) continue;
      if (s.role === "leader") {
        if (t - (lastHeartbeat[s.id] ?? -Infinity) >= heartbeat) {
          for (const peer of ids) if (peer !== s.id) sendAppend(s, peer, t);
          lastHeartbeat[s.id] = t;
        }
      } else if (t >= s.electionDeadline) {
        s.role = "candidate";
        s.term++;
        s.votedFor = s.id;
        s.votes = [s.id];
        s.electionDeadline = timeout(t);
        notes.push(`${s.id} hears nothing from a leader: it becomes a candidate for term ${s.term} and asks for votes`);
        for (const peer of ids) if (peer !== s.id) send(s.id, peer, { type: "RequestVote", term: s.term, lastLogIndex: s.log.length, lastLogTerm: lastTerm(s) }, t);
        if (s.votes.length >= majority) becomeLeader(s, t, notes);
      }
    }
    frames.push({ time: t, servers: servers.map(copyServer), messages: [...flight, ...arriving].map((m) => ({ ...m })), groups: groups ? groups.map((g) => [...g]) : null, notes });
  }
  return frames;

  function send(from: string, to: string, msg: Message, t: number): void {
    flight.push({ id: nextMessage++, from, to, sent: t, arrives: t + delay, msg });
  }

  function sendAppend(leader: Server, peer: string, t: number): void {
    const next = leader.nextIndex[peer] ?? leader.log.length + 1;
    const prevIndex = next - 1;
    send(leader.id, peer, {
      type: "AppendEntries", term: leader.term, prevIndex, prevTerm: prevIndex > 0 ? leader.log[prevIndex - 1]!.term : 0,
      entries: leader.log.slice(prevIndex), leaderCommit: leader.commitIndex,
    }, t);
  }

  function stepDown(s: Server, term: number, t: number): void {
    if (term > s.term) {
      s.term = term;
      s.votedFor = null;
    }
    if (s.role !== "follower") {
      // A fresh timeout: a former leader's deadline is long past and would start an election at once.
      s.role = "follower";
      s.votes = [];
      s.electionDeadline = timeout(t);
    }
  }

  function becomeLeader(s: Server, t: number, notes: string[]): void {
    s.role = "leader";
    for (const peer of ids) {
      s.nextIndex[peer] = s.log.length + 1;
      s.matchIndex[peer] = 0;
    }
    // A new leader appends a blank entry of its own term at once (§8 of the paper). Entries from earlier
    // terms can only be committed together with one of the current term (Figure 8), so without it they
    // could wait forever for the next client request.
    if (c.noop ?? true) {
      s.log.push({ term: s.term, command: NOOP });
      notes.push(`${s.id} has votes from a majority (${s.votes.join(", ")}): it is the leader for term ${s.term}, and appends a no-op entry to commit everything before it`);
    } else notes.push(`${s.id} has votes from a majority (${s.votes.join(", ")}): it is the leader for term ${s.term}`);
    s.matchIndex[s.id] = s.log.length;
    advanceCommit(s, notes);
    for (const peer of ids) if (peer !== s.id) sendAppend(s, peer, t);
    lastHeartbeat[s.id] = t;
  }

  /** Commit the highest index replicated on a majority — but only an entry of the current term
   *  (committing older-term entries by counting replicas is unsafe: Figure 8 of the paper). */
  function advanceCommit(s: Server, notes: string[]): void {
    for (let n = s.log.length; n > s.commitIndex; n--) {
      const replicas = ids.filter((id) => (id === s.id ? s.log.length : s.matchIndex[id] ?? 0) >= n).length;
      if (replicas >= majority && s.log[n - 1]!.term === s.term) {
        notes.push(`entry ${n} ("${s.log[n - 1]!.command}") is on a majority (${replicas} of ${ids.length}): ${s.id} commits it${n - s.commitIndex > 1 ? " and everything before it" : ""}`);
        s.commitIndex = n;
        return;
      }
    }
  }

  function receive(s: Server, m: InFlight, t: number, notes: string[]): void {
    const msg = m.msg;
    if (msg.term > s.term) {
      const was = s.role;
      stepDown(s, msg.term, t);
      if (was === "leader") notes.push(`${s.id} sees term ${msg.term} from ${m.from}: a newer term exists, so it steps down`);
    }
    switch (msg.type) {
      case "RequestVote": {
        const upToDate = msg.lastLogTerm > lastTerm(s) || (msg.lastLogTerm === lastTerm(s) && msg.lastLogIndex >= s.log.length);
        const grant = msg.term === s.term && (s.votedFor === null || s.votedFor === m.from) && upToDate;
        if (grant) {
          s.votedFor = m.from;
          s.electionDeadline = timeout(t);
          notes.push(`${s.id} votes for ${m.from} in term ${msg.term}`);
        } else if (msg.term === s.term && !upToDate) {
          notes.push(`${s.id} refuses ${m.from}: its log is less up to date — a leader must hold every committed entry`);
        }
        send(s.id, m.from, { type: "Vote", term: s.term, granted: grant }, t);
        return;
      }
      case "Vote": {
        if (s.role !== "candidate" || msg.term !== s.term || !msg.granted) return;
        if (!s.votes.includes(m.from)) s.votes.push(m.from);
        if (s.votes.length >= majority) becomeLeader(s, t, notes);
        return;
      }
      case "AppendEntries": {
        if (msg.term < s.term) {
          send(s.id, m.from, { type: "AppendReply", term: s.term, success: false, matchIndex: 0 }, t);
          return;
        }
        if (s.role !== "follower") stepDown(s, msg.term, t);
        s.electionDeadline = timeout(t);
        const ok = msg.prevIndex === 0 || (msg.prevIndex <= s.log.length && s.log[msg.prevIndex - 1]!.term === msg.prevTerm);
        if (!ok) {
          notes.push(`${s.id} refuses ${m.from}'s entries: it has no entry at index ${msg.prevIndex} with term ${msg.prevTerm} to attach them to`);
          send(s.id, m.from, { type: "AppendReply", term: s.term, success: false, matchIndex: 0 }, t);
          return;
        }
        // Append, replacing any conflicting suffix (entries after a mismatch were never committed).
        msg.entries.forEach((e, i) => {
          const index = msg.prevIndex + 1 + i;
          const existing = s.log[index - 1];
          if (existing && existing.term !== e.term) {
            notes.push(`${s.id} drops its uncommitted entries from index ${index} on: they conflict with leader ${m.from}'s log`);
            s.log.length = index - 1;
          }
          if (!s.log[index - 1]) s.log.push({ ...e });
        });
        const match = msg.prevIndex + msg.entries.length;
        const newCommit = Math.min(msg.leaderCommit, match);
        if (newCommit > s.commitIndex) s.commitIndex = newCommit;
        send(s.id, m.from, { type: "AppendReply", term: s.term, success: true, matchIndex: match }, t);
        return;
      }
      case "AppendReply": {
        if (s.role !== "leader" || msg.term !== s.term) return;
        if (!msg.success) {
          s.nextIndex[m.from] = Math.max(1, (s.nextIndex[m.from] ?? 1) - 1); // back up and try again
          notes.push(`${s.id} backs up: it will send ${m.from} entries from index ${s.nextIndex[m.from]} on`);
          sendAppend(s, m.from, t);
          return;
        }
        s.matchIndex[m.from] = Math.max(s.matchIndex[m.from] ?? 0, msg.matchIndex);
        s.nextIndex[m.from] = s.matchIndex[m.from]! + 1;
        advanceCommit(s, notes);
        return;
      }
    }
  }
}

function copyServer(s: Server): Server {
  return { ...s, log: s.log.map((e) => ({ ...e })), votes: [...s.votes], nextIndex: { ...s.nextIndex }, matchIndex: { ...s.matchIndex } };
}

/** Parse a script like "30 crash A", "45 client x=1", "60 partition A B | C D E", "90 heal". */
export function parseEvents(text: string): Event[] {
  return text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(\d+)\s+(\w+)\s*(.*)$/);
    if (!m) throw new SyntaxError(`"${line}": expected "<tick> <action> ..."`);
    const at = Number(m[1]);
    const action = m[2]!.toLowerCase();
    const rest = m[3]!.trim();
    switch (action) {
      case "crash":
      case "restart":
        if (!/^[A-G]$/.test(rest)) throw new SyntaxError(`"${line}": which server (A–G)?`);
        return { at, kind: action, server: rest };
      case "heal":
        return { at, kind: "heal" };
      case "partition": {
        const groups = rest.split("|").map((g) => g.trim().split(/\s+/).filter(Boolean));
        if (groups.length < 2 || groups.some((g) => g.length === 0 || g.some((s) => !/^[A-G]$/.test(s)))) throw new SyntaxError(`"${line}": e.g. "partition A B | C D E"`);
        return { at, kind: "partition", groups };
      }
      case "client": {
        const c = rest.match(/^(\S+)(?:\s+at\s+([A-G]))?$/);
        if (!c) throw new SyntaxError(`"${line}": e.g. "client x=1" or "client x=1 at B"`);
        return { at, kind: "client", command: c[1]!, ...(c[2] ? { to: c[2] } : {}) };
      }
      default:
        throw new SyntaxError(`"${line}": unknown action "${action}"`);
    }
  });
}
