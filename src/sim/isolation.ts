// Transactions running at the same time, and what each isolation level lets them see.
//
// A schedule interleaves the operations of a few transactions: read a key, write a key (a constant, or a
// value computed from what this transaction read), commit, abort. The database keeps every committed
// version of every key, as MVCC databases do. What a read returns, and whether a commit is allowed,
// depends on the isolation level:
//
// * Read Uncommitted — reads see the newest write, even one not committed yet (dirty reads).
// * Read Committed   — reads see the newest *committed* value at the moment of the read.
// * Snapshot         — reads see the database as of the transaction's start; of two transactions that
//                      wrote the same key, the second to commit is aborted ("first committer wins").
//                      PostgreSQL's REPEATABLE READ and Oracle's SERIALIZABLE are this.
// * Serializable     — snapshot reads, and at commit the transaction is aborted if anything it *read or
//                      wrote* was changed by a transaction that committed since it started (optimistic
//                      validation). Every outcome then equals some serial order.
//
// Not modelled: row locks and waiting. Real databases often make a writer wait for another writer's
// commit; here a write never blocks, and the conflict surfaces (or not) at commit.

export type Level = "Read Uncommitted" | "Read Committed" | "Snapshot" | "Serializable";
export const MAX_TRANSACTIONS = 6;

export const LEVELS: readonly Level[] = ["Read Uncommitted", "Read Committed", "Snapshot", "Serializable"];

export type Op =
  | { tx: string; kind: "read"; key: string }
  | { tx: string; kind: "write"; key: string; expr: Expr }
  | { tx: string; kind: "commit" }
  | { tx: string; kind: "abort" };

/** A constant, or a key this transaction read plus a constant: `x + 1`, `y - 50`, `100`. */
export interface Expr {
  key?: string;
  add: number;
}

export interface Schedule {
  initial: Record<string, number>;
  ops: Op[];
}

export type Status = "active" | "committed" | "aborted";

export interface TxView {
  status: Status;
  /** Values this transaction read, in order. */
  reads: { key: string; value: number }[];
  /** Its own writes, not yet committed (or discarded). */
  writes: Record<string, number>;
  abortReason?: string;
}

export interface Step {
  index: number;
  op: Op;
  /** What happened, e.g. "T2 reads x = 10". */
  text: string;
  /** Skipped because the transaction had already ended. */
  skipped: boolean;
  committed: Record<string, number>;
  txs: Record<string, TxView>;
  note: string;
}

export interface Outcome {
  steps: Step[];
  final: Record<string, number>;
  txs: Record<string, TxView>;
  /** A serial order of the committed transactions that gives the same reads and final state, or null. */
  serialOrder: string[] | null;
}

interface Version {
  value: number;
  commitTs: number;
  tx: string | null;
  /** Position in the schedule where it became visible (for Read Uncommitted's "newest"). */
  at: number;
}

export function run(schedule: Schedule, level: Level): Outcome {
  const versions: Record<string, Version[]> = {};
  for (const [k, v] of Object.entries(schedule.initial)) versions[k] = [{ value: v, commitTs: 0, tx: null, at: -1 }];
  let clock = 0;
  const txs: Record<string, TxView & { startTs: number; readTs: Record<string, number>; written: string[] }> = {};
  const writeOrder: { tx: string; key: string; value: number; at: number }[] = []; // for dirty reads
  const steps: Step[] = [];

  const latestCommitted = (key: string, before = Infinity) => {
    const vs = versions[key] ?? [];
    for (let i = vs.length - 1; i >= 0; i--) if (vs[i]!.commitTs <= before) return vs[i]!;
    return undefined;
  };

  schedule.ops.forEach((op, index) => {
    const tx = (txs[op.tx] ??= { status: "active", reads: [], writes: {}, startTs: clock, readTs: {}, written: [] });
    let text: string;
    let note = "";
    let skipped = false;
    if (tx.status !== "active") {
      skipped = true;
      text = `${op.tx} ${describe(op)} — skipped`;
      note = `${op.tx} has already ${tx.status === "aborted" ? "been aborted" : "committed"}, so this operation does not happen.`;
    } else if (op.kind === "read") {
      let value: number;
      if (op.key in tx.writes) {
        value = tx.writes[op.key]!;
        note = `${op.tx} sees its own write.`;
      } else if (level === "Read Uncommitted") {
        // The newest value: the latest uncommitted write by a still-open transaction, unless a commit
        // happened after it. (A first version preferred any open write over a newer commit.)
        const committed = latestCommitted(op.key);
        const open = [...writeOrder].reverse().find((w) => w.key === op.key && txs[w.tx]!.status === "active");
        const dirty = open && open.at > (committed?.at ?? -1) ? open : undefined;
        value = dirty?.value ?? committed?.value ?? 0;
        note = dirty ? `Read Uncommitted shows ${dirty.tx}'s write, which is not committed — a dirty read.` : "The newest value, committed or not.";
        tx.readTs[op.key] = committed?.commitTs ?? 0;
      } else if (level === "Read Committed") {
        const v = latestCommitted(op.key);
        value = v?.value ?? 0;
        note = "Read Committed: the newest committed value, as of this moment.";
        tx.readTs[op.key] = v?.commitTs ?? 0;
      } else {
        const v = latestCommitted(op.key, tx.startTs);
        value = v?.value ?? 0;
        const newer = latestCommitted(op.key);
        note = newer && newer.commitTs > tx.startTs
          ? `${op.tx} reads from its snapshot (taken when it started): ${value}, although ${newer.tx} has since committed ${newer.value}.`
          : `${op.tx} reads from its snapshot, taken when it started.`;
        tx.readTs[op.key] = v?.commitTs ?? 0;
      }
      tx.reads.push({ key: op.key, value });
      text = `${op.tx} reads ${op.key} = ${value}`;
    } else if (op.kind === "write") {
      const base = op.expr.key === undefined ? 0 : (tx.writes[op.expr.key] ?? lastRead(tx, op.expr.key));
      if (base === undefined) throw new RangeError(`${op.tx} writes ${op.key} from ${op.expr.key}, which it has not read first`);
      const value = base + op.expr.add;
      tx.writes[op.key] = value;
      if (!tx.written.includes(op.key)) tx.written.push(op.key);
      writeOrder.push({ tx: op.tx, key: op.key, value, at: index });
      text = `${op.tx} writes ${op.key} = ${value}`;
      note = `${op.tx}'s write is private until it commits${level === "Read Uncommitted" ? " — except under Read Uncommitted, where others can already see it" : ""}.`;
    } else if (op.kind === "abort") {
      tx.status = "aborted";
      tx.abortReason = "aborted by the transaction";
      text = `${op.tx} aborts`;
      note = `${op.tx} rolls back: its writes vanish${level === "Read Uncommitted" ? " — but anyone who read them has already seen values that never existed" : ""}.`;
    } else {
      const conflict = validate(op.tx);
      if (conflict) {
        tx.status = "aborted";
        tx.abortReason = conflict;
        text = `${op.tx} tries to commit — aborted`;
        note = `${conflict} The database aborts ${op.tx}; the application would retry it.`;
      } else {
        clock++;
        for (const [k, v] of Object.entries(tx.writes)) (versions[k] ??= []).push({ value: v, commitTs: clock, tx: op.tx, at: index });
        tx.status = "committed";
        text = `${op.tx} commits`;
        note = Object.keys(tx.writes).length ? `${op.tx}'s writes (${Object.entries(tx.writes).map(([k, v]) => `${k} = ${v}`).join(", ")}) become visible.` : `${op.tx} wrote nothing.`;
      }
    }
    steps.push({ index, op, text, skipped, committed: committedState(), txs: viewTxs(), note });
  });

  // Transactions still open at the end are rolled back.
  for (const tx of Object.values(txs)) if (tx.status === "active") {
    tx.status = "aborted";
    tx.abortReason = "never committed";
  }
  const final = committedState();
  return { steps, final, txs: viewTxs(), serialOrder: findSerialOrder(schedule, txs, final) };

  function validate(name: string): string | null {
    const tx = txs[name]!;
    if (level === "Snapshot" || level === "Serializable") {
      for (const k of tx.written) {
        const v = latestCommitted(k);
        if (v && v.commitTs > tx.startTs) return `${v.tx} committed a write to ${k} after ${name} started: first committer wins.`;
      }
    }
    if (level === "Serializable") {
      for (const k of Object.keys(tx.readTs)) {
        const v = latestCommitted(k);
        if (v && v.commitTs > tx.startTs) return `${name} read ${k}, and ${v.tx} has since committed a change to it: ${name}'s reads are stale, so committing could break serializability.`;
      }
    }
    return null;
  }

  function committedState(): Record<string, number> {
    return Object.fromEntries(Object.keys(versions).sort().map((k) => [k, versions[k]!.at(-1)!.value]));
  }

  function viewTxs(): Record<string, TxView> {
    return Object.fromEntries(Object.entries(txs).map(([n, t]) => [n, { status: t.status, reads: [...t.reads], writes: { ...t.writes }, ...(t.abortReason ? { abortReason: t.abortReason } : {}) }]));
  }
}

function lastRead(tx: TxView, key: string): number | undefined {
  for (let i = tx.reads.length - 1; i >= 0; i--) if (tx.reads[i]!.key === key) return tx.reads[i]!.value;
  return undefined;
}

/** Could this outcome have come from running the committed transactions one after another? Try every
 *  order: each must reproduce every read the committed transactions made, and the final state. */
function findSerialOrder(schedule: Schedule, txs: Record<string, TxView>, final: Record<string, number>): string[] | null {
  const committed = Object.keys(txs).filter((n) => txs[n]!.status === "committed");
  for (const order of permutations(committed)) {
    const db = { ...schedule.initial };
    let ok = true;
    for (const name of order) {
      const local: Record<string, number> = {};
      const seen: Record<string, number> = {};
      const reads: number[] = [];
      for (const op of schedule.ops.filter((o) => o.tx === name)) {
        if (op.kind === "read") {
          const v = local[op.key] ?? db[op.key] ?? 0;
          reads.push(v);
          seen[op.key] = v;
        } else if (op.kind === "write") {
          const base = op.expr.key === undefined ? 0 : (local[op.expr.key] ?? seen[op.expr.key] ?? 0);
          local[op.key] = base + op.expr.add;
        }
      }
      if (reads.some((v, i) => v !== txs[name]!.reads[i]?.value)) {
        ok = false;
        break;
      }
      Object.assign(db, local);
    }
    if (ok && Object.keys(final).every((k) => (db[k] ?? 0) === final[k])) return order;
  }
  return null;
}

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) {
    yield [...xs];
    return;
  }
  for (let i = 0; i < xs.length; i++) for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i]!, ...rest];
}

export function describe(op: Op): string {
  switch (op.kind) {
    case "read":
      return `read ${op.key}`;
    case "write":
      return `write ${op.key} = ${op.expr.key ?? ""}${op.expr.key !== undefined && op.expr.add !== 0 ? (op.expr.add > 0 ? ` + ${op.expr.add}` : ` - ${-op.expr.add}`) : ""}${op.expr.key === undefined ? op.expr.add : ""}`;
    default:
      return op.kind;
  }
}

/**
 * Parse a schedule:
 *   init x=10 y=0
 *   T1 read x
 *   T1 write x = x + 1
 *   T2 commit
 */
export function parseSchedule(text: string): Schedule {
  const initial: Record<string, number> = {};
  const ops: Op[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (line.startsWith("init")) {
      for (const m of line.slice(4).matchAll(/([a-z]\w*)\s*=\s*(-?\d+)/gi)) initial[m[1]!] = Number(m[2]);
      continue;
    }
    const m = line.match(/^(T\d+)\s+(read|write|commit|abort)\b\s*(.*)$/i);
    if (!m) throw new SyntaxError(`"${line}": expected e.g. "T1 read x", "T1 write x = x + 1", "T1 commit"`);
    const tx = m[1]!.toUpperCase();
    const kind = m[2]!.toLowerCase();
    const rest = m[3]!.trim();
    if (kind === "read") {
      if (!/^[a-z]\w*$/i.test(rest)) throw new SyntaxError(`"${line}": read what?`);
      ops.push({ tx, kind, key: rest });
    } else if (kind === "write") {
      const w = rest.match(/^([a-z]\w*)\s*=\s*(?:([a-z]\w*)\s*(?:([+-])\s*(\d+))?|(-?\d+))$/i);
      if (!w) throw new SyntaxError(`"${line}": write needs "key = value", "key = other", or "key = other + n"`);
      const expr: Expr = w[5] !== undefined ? { add: Number(w[5]) } : { key: w[2]!, add: w[4] ? (w[3] === "-" ? -1 : 1) * Number(w[4]) : 0 };
      ops.push({ tx, kind, key: w[1]!, expr });
    } else ops.push({ tx, kind: kind as "commit" | "abort" });
  }
  if (ops.length === 0) throw new SyntaxError("the schedule is empty");
  // The serializability check tries every order of the committed transactions: n! of them. Six is 720
  // orders and instant; ten would be 3.6 million and freeze the page.
  const txCount = new Set(ops.map((o) => o.tx)).size;
  if (txCount > MAX_TRANSACTIONS) throw new RangeError(`at most ${MAX_TRANSACTIONS} transactions (this schedule has ${txCount})`);
  return { initial, ops };
}

/** The classic anomalies, each as a schedule — the presets of the page and the cases of the tests. */
export const SCENARIOS = {
  dirtyRead: {
    name: "Dirty read",
    about: "T1 writes x and later rolls back; T2 reads x in between. Did T2 see a value that never existed?",
    schedule: "init x=10\nT1 write x = 99\nT2 read x\nT2 commit\nT1 abort",
  },
  nonRepeatable: {
    name: "Non-repeatable read",
    about: "T1 reads x twice; T2 changes x in between and commits. Does T1 get the same answer both times?",
    schedule: "init x=10\nT1 read x\nT2 write x = 20\nT2 commit\nT1 read x\nT1 commit",
  },
  lostUpdate: {
    name: "Lost update",
    about: "Two transactions each add 1 to x (read, then write the value plus one). x starts at 10: it should end at 12.",
    schedule: "init x=10\nT1 read x\nT2 read x\nT1 write x = x + 1\nT1 commit\nT2 write x = x + 1\nT2 commit",
  },
  writeSkew: {
    name: "Write skew",
    about: "The hospital rule: at least one doctor on call. Alice and Bob are both on call (1); each checks that the other is, then goes off call (0).",
    schedule: "init alice=1 bob=1\nT1 read alice\nT1 read bob\nT2 read alice\nT2 read bob\nT1 write alice = 0\nT2 write bob = 0\nT1 commit\nT2 commit",
  },
} as const;