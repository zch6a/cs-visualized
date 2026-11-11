// Test the tests: put one deliberate bug at a time into a copy of the simulations and check that some
// test fails.
//
//   node scripts/mutate.ts
//
// Each mutant is a small, plausible mistake in a simulation's key rule. A mutant that "survives" — the
// whole suite still passes — means a rule that matters is untested. The repository is never modified:
// src/sim and test are copied into a temporary folder and the suite runs there. A mutant that makes the
// tests hang counts as caught after a timeout.
//
// Left out because they cannot change behaviour here (equivalent mutants): a follower committing up to
// leaderCommit without capping it at what it just matched (every AppendEntries carries the leader's whole
// suffix, so the match is never below leaderCommit), and `<=` for `<` in the ring's binary search (two
// points at the same 32-bit position never occur in practice).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MUTANTS: [file: string, original: string, mutant: string][] = [
  // paging
  ["paging.ts", "return argMin(loadedAt);", "return argMax(loadedAt);"],
  ["paging.ts", "return argMin(lastUsed);", "return argMin(loadedAt);"],
  ["paging.ts", "return next < 0 ? Infinity : next;", "return next < 0 ? -1 : next;"],
  ["paging.ts", "while (refBits[hand]) {", "while (false) {"],
  ["paging.ts", "      lastUsed[at] = time;\n      refBits[at] = true;", "      refBits[at] = true;"],
  // scheduling
  ["scheduling.ts", "if (running) return running; // non-preemptive: runs to completion", "// (mutant: SJF preempts)"],
  ["scheduling.ts", "const next = minBy(queues[0]!, (n) => burst(n));", "const next = queues[0]![0];"],
  ["scheduling.ts", "    if (requeue) {\n      queues[levelOf[requeue]!]!.push(requeue);", "    if (requeue) {\n      queues[levelOf[requeue]!]!.unshift(requeue);"],
  ["scheduling.ts", "levelOf[running]! += 1;", "levelOf[running]! += 0;"],
  ["scheduling.ts", "if (algorithm === \"MLFQ\" && boost > 0 && time > 0 && time % boost === 0) {", "if (false) {"],
  ["scheduling.ts", "if (top >= 0 && top < levelOf[running]!) {", "if (false) {"],
  // congestion
  ["congestion.ts", "cwnd = Math.min(cwnd * 2, ssthresh);", "cwnd = cwnd * 2;"],
  ["congestion.ts", "      cwnd += 1;\n      note = \"Congestion avoidance", "      cwnd += 2;\n      note = \"Congestion avoidance"],
  ["congestion.ts", "        cwnd = ssthresh;", "        cwnd = 1;"],
  ["congestion.ts", "ssthresh = Math.max(2, Math.floor(cwnd / 2));", "ssthresh = Math.max(2, cwnd);"],
  ["congestion.ts", "      a /= 2;\n      b /= 2;", "      a -= 1;\n      b -= 1;"],
  // transport
  ["transport.ts", "for (let s = base; s < next; s++) if (!resend.includes(s)) resend.push(s);", "if (!resend.includes(base)) resend.push(base);"],
  ["transport.ts", "if (protocol === \"TCP\" && dupAcks === 3 && fastRetransmitted !== base) {", "if (false) {"],
  ["transport.ts", "if (s >= expected && s < expected + W) buffer.add(s);", "if (s === expected) buffer.add(s);"],
  ["transport.ts", "} else if (next < N && next < base + W) {", "} else if (next < N) {"],
  ["transport.ts", "send(\"server\", \"ACK\", t, { ack: protocol === \"Selective Repeat\" ? s : expected });", "send(\"server\", \"ACK\", t, { ack: expected });"],
  // B+ tree
  ["bplustree.ts", "while (i < separators.length && key >= separators[i]!) i++;", "while (i < separators.length && key > separators[i]!) i++;"],
  ["bplustree.ts", "const right = this.node(n.keys.slice(mid + 1), n.children.slice(mid + 1));", "const right = this.node(n.keys.slice(mid), n.children.slice(mid + 1));"],
  ["bplustree.ts", "      right.next = n.next;\n      n.next = right;", "      n.next = right;"],
  ["bplustree.ts", "if (n.keys.includes(key)) {", "if (false) {"],
  // isolation
  ["isolation.ts", "const v = latestCommitted(op.key, tx.startTs);", "const v = latestCommitted(op.key);"],
  ["isolation.ts", "if (v && v.commitTs > tx.startTs) return `${v.tx} committed a write", "if (false) return `${v?.tx} committed a write"],
  ["isolation.ts", "for (const k of Object.keys(tx.readTs)) {", "for (const k of [] as string[]) {"],
  ["isolation.ts", "if (op.key in tx.writes) {", "if (false) {"],
  ["isolation.ts", "if (ok && Object.keys(final).every((k) => (db[k] ?? 0) === final[k])) return order;", "if (ok) return order;"],
  // hashing
  ["hashing.ts", "return this.points[lo % this.points.length]!;", "return this.points[Math.min(lo, this.points.length - 1)]!;"],
  ["hashing.ts", "  h ^= h >>> 16;\n  h = Math.imul(h, 0x85ebca6b) >>> 0;", "  h = Math.imul(h, 0x85ebca6b) >>> 0;"],
  ["hashing.ts", "return nodes[fnv1a(key) % nodes.length]!;", "return nodes[fnv1a(key) % 5]!;"],
  // raft
  ["raft.ts", "const grant = msg.term === s.term && (s.votedFor === null || s.votedFor === m.from) && upToDate;", "const grant = msg.term === s.term && (s.votedFor === null || s.votedFor === m.from);"],
  ["raft.ts", "const grant = msg.term === s.term && (s.votedFor === null || s.votedFor === m.from) && upToDate;", "const grant = msg.term === s.term && upToDate;"],
  ["raft.ts", "if (replicas >= majority && s.log[n - 1]!.term === s.term) {", "if (replicas >= majority) {"],
  ["raft.ts", "if (existing && existing.term !== e.term) {", "if (false) {"],
  ["raft.ts", "if (msg.term < s.term) {\n          send(s.id, m.from, { type: \"AppendReply\"", "if (false) {\n          send(s.id, m.from, { type: \"AppendReply\""],
  ["raft.ts", "s.nextIndex[m.from] = Math.max(1, (s.nextIndex[m.from] ?? 1) - 1); // back up and try again", "s.nextIndex[m.from] = Math.max(1, s.nextIndex[m.from] ?? 1);"],
  ["raft.ts", "    s.log.push({ term: s.term, command: NOOP });", "    // (mutant: no no-op)"],
];

const tmp = mkdtempSync(join(tmpdir(), "cs-mutate-"));
let caught = 0;
const survived: string[] = [];
try {
  cpSync(join(root, "src"), join(tmp, "src"), { recursive: true });
  cpSync(join(root, "test"), join(tmp, "test"), { recursive: true });
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  // The unmutated suite must pass first. (A first version passed "test/" to node --test, which Node 24
  // treats as a module name: every run failed, so every mutant counted as "caught".)
  const baseline = runSuite();
  if (baseline.status !== 0) {
    console.error("The test suite fails without any mutant — fix that first:\n" + baseline.stdout.slice(-2000));
    process.exit(2);
  }
  MUTANTS.forEach(([file, original, mutant], i) => {
    const path = join(tmp, "src", "sim", file);
    const source = readFileSync(path, "utf8");
    const label = `${String(i + 1).padStart(2)}. ${file}: ${original.split("\n")[0]!.trim().slice(0, 70)}`;
    if (!source.includes(original)) {
      console.log(`${label}\n    NOT FOUND — the code changed; update this list`);
      survived.push(label);
      return;
    }
    writeFileSync(path, source.replace(original, mutant));
    const r = runSuite();
    writeFileSync(path, source);
    const ok = r.status !== 0 || r.signal !== null;
    console.log(`${ok ? "caught  " : "SURVIVED"} ${label}`);
    if (ok) caught++;
    else survived.push(label);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${caught} of ${MUTANTS.length} mutants caught`);

function runSuite() {
  return spawnSync(process.execPath, ["--test", "--test-reporter=dot", "test/**/*.test.ts"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
}
process.exit(survived.length ? 1 : 0);
