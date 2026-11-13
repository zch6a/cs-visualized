# Changelog

## 0.2.0 — fixes from an independent review

The simulations themselves held up: fuzzed against reference implementations and invariant checks
(paging, scheduling, serializability, the B+ tree, transport, Raft's safety properties), and every
number in the READMEs reproduced. The fixes are around them.

**Fixes**

- **Isolation**: an operation skipped because its transaction had already committed was still replayed
  when looking for a serial order, so `T1 read x / T1 commit / T1 read x` was called "not serializable".
- **TCP congestion**: after one rejected input (a link capacity of 3), every step of the player threw and
  the chart stopped moving; it now keeps showing the last good run.
- **Page replacement**: choosing a policy while the input was invalid drew the old run with the new
  policy's marks (Clock's reference bits on an LRU run) and left the old button pressed. The choice now
  changes only when the run does.
- **Raft**: a seed of 0 or below gave election timeouts shorter than a round trip (seed −1: no leader in
  200 ticks); the page and the simulation refuse it. A "things to try" item pointed at the wrong preset
  for the failed election (it is in *Catch up after a crash*).
- **Inputs**: the B+ tree's order (3–8, as the box says), the number of servers for consistent hashing
  and MLFQ's boost period are checked instead of silently accepted.
- **Accessibility**: de-emphasised text (future steps, crashed servers) is a colour with 4.5:1 contrast
  instead of faded with opacity (it was 2–2.9:1); two palette colours darkened to at least 3:1; the step
  slider says "step 3 of 60" to a screen reader instead of "2".
- **Hardening**: a Content-Security-Policy (scripts and styles from the site only; inline styles go
  through the CSSOM); the preview server listens on 127.0.0.1 only, refuses paths with ":" (Windows data
  streams) and handles a read error.
- **Mutation testing** copies the workflows too (the workflow test added in the CI hardening made every
  run fail) and has two new mutants for the fixes: 42 of 42 caught.

## 0.1.0 — first release

Eight interactive, step-through simulations in a static site with no runtime dependencies.

**Topics**

- **Page replacement** — FIFO, LRU, OPT and Clock, with a sentence per step on why each page was evicted,
  and a policies × 1–8 frames table that marks Bélády's anomaly.
- **CPU scheduling** — FCFS, SJF, SRTF, round robin and MLFQ (slices per level, allotment kept across
  preemptions, optional priority boost) on a Gantt chart, with turnaround, waiting and response times.
- **TCP congestion control** — slow start, congestion avoidance, Tahoe vs Reno on a capacity-limited link,
  and two AIMD flows converging to a fair share.
- **Reliable delivery** — the handshake, a sliding window and the teardown on a sequence diagram; Go-Back-N,
  Selective Repeat and TCP's fast retransmit compared on the same losses.
- **B+ tree** — inserts with leaf and inner splits, search, and range scans along the leaf links.
- **Transaction isolation** — a small MVCC store, four isolation levels, the classic anomalies as presets,
  and a check of every outcome against all serial orders.
- **Consistent hashing** — a hash ring with virtual nodes; keys moved and load balance compared with
  `hash mod N`.
- **Raft** — elections with randomized timeouts, log replication with conflict repair, commitment by the
  current term's majority, the no-op entry of a new leader, crashes, restarts and partitions.

**Quality**

- 80 tests against textbook numbers and invariants, including the Raft paper's safety properties checked on
  every tick of 60 random fault schedules; `npm run mutate` puts 40 deliberate bugs into the simulations one
  at a time, checks that the unchanged suite passes first, and every bug makes a test fail.
- Pages work at phone width, in light and dark mode, and with the keyboard; colour contrast measured.
- Five rounds of review — code, a learner doing every exercise, the literature (RFCs, the Raft paper,
  PostgreSQL docs, OSTEP), mutation testing, and a final read-through — recorded in
  [POLISH_LOG.md](POLISH_LOG.md).
