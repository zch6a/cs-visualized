# Changelog

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
