# Polish log

Each round goes through the whole project — every simulation checked against textbook numbers and
invariants, every page used in the browser (light and dark, desktop and phone width, keyboard only),
the code read top to bottom, docs, first-run experience — then a local commit.

## Development

- [x] **Scope and stack.** A static site of interactive, step-through simulations across four areas
  (operating systems, networking, databases, distributed systems), about 8–12 topics. Every simulation
  is a pure TypeScript function from input to a list of steps (snapshot + one-sentence explanation),
  tested with `node --test` against textbook numbers and invariants; pages draw one step at a time
  through a shared player. No framework, no bundler, no runtime dependencies — `tsc` (dev dependency)
  compiles to ES modules; a 60-line Node server serves `dist/` and rebuilds on save.
- [x] **Page replacement** (`src/sim/paging.ts`, `src/topics/paging.ts`): FIFO, LRU, OPT and Clock with
  stable frame positions and a sentence per step explaining the victim. Tests: Silberschatz's reference
  string gives the textbook 15/12/9 faults; Bélády's anomaly (9 → 10 faults with more frames, FIFO);
  LRU and OPT never fault more with more frames (4 reference strings × 7 sizes); OPT is never beaten
  (5 random strings × 6 sizes × 4 policies); Clock's second chance (a case where it spares the page FIFO
  evicts — the first version of that test had the wrong expectation: Clock only spares a page whose
  bit was set *after* the hand last passed). Page: reference-string input with presets, policy
  switch, a frames × time table with hits/faults/reference bits/the hand, and a policies × 1–8 frames
  table that marks the anomaly.
  - **Found by using it**: a rebuild triggered by the watcher at the same moment as a manual build
    failed to delete `dist/` on Windows (EPERM) and crashed the dev server. The build now empties
    `dist/` instead of removing it, and the watcher keeps serving the last good build if a rebuild fails.
- [x] **CPU scheduling** (`src/sim/scheduling.ts`, `src/topics/scheduling.ts`): FCFS, SJF, SRTF, round robin and MLFQ (configurable slices per level, optional priority boost) on whole ticks, with a sentence per tick (arrivals, preemptions, demotions, boosts). Conventions stated in code and tested: a new arrival joins the queue *before* a process whose slice just ended; ties go to earlier arrival, then input order. 10 tests: the textbook averages (FCFS convoy 17 vs 3, SJF 7, SRTF 6.5 with the preemption at t=1, RR q=4 17/3); MLFQ demotion and preemption by a new top-queue job; boost ends starvation; idle ticks; and on 30 random workloads every process gets exactly its burst, never before arriving, the CPU is never idle with work waiting, SRTF has the lowest average wait of all five, SJF beats FCFS. Page: process editor with presets, a Gantt chart with run/wait/arrival marks, the queues with remaining time, per-process turnaround/waiting/response filled in as they happen, and all five policies compared.
  - **Found by using it**: the MLFQ preset showed `ui1` waiting one tick while `ui2`–`ui4` did not — correct (the batch job was still in its first top-queue slice), and a better question than the one the page asked, so the exercise now asks why.
- [x] **TCP congestion control** (`src/sim/congestion.ts`, `src/topics/congestion.ts`): a round-trip model in whole segments — slow start doubling up to `ssthresh`, additive increase, and on a loss Tahoe (always back to 1) or Reno (halve on three duplicate ACKs, 1 on a timeout); losses come from a link capacity (one dropped segment when the window exceeds it) and from scheduled timeouts. Plus two AIMD flows on one link. 9 tests: doubling and the switch at a threshold that is not a power of two, Tahoe and Reno reactions, the sawtooth (losses exactly at capacity + 1, window never below half, about 3/4 of the link delivered — the textbook figure), Reno delivers more than Tahoe, per-round consistency, and the Chiu–Jain argument checked exactly: every loss halves the gap between the two flows, increases leave it unchanged. Page: an SVG chart of cwnd and ssthresh with loss markers and the other variant as a ghost line, and a phase plot of flow A against flow B with the fairness and capacity lines.
  - **Found by using it**: with two players on one page, the arrow keys moved both. The keyboard now drives the player used last (the first one until then). A chart label sat on top of the curve's end point — moved.
- [x] **Reliable delivery** (`src/sim/transport.ts`, `src/topics/transport.ts`): the three-way handshake, a sliding window of data and the four-message teardown, tick by tick with a one-way delay, one segment per tick from the client, and losses of chosen data segments or ACK numbers (first transmission) or at random with a seed. Three recovery schemes: Go-Back-N (in-order receiver, cumulative ACKs, resend the window on timeout), Selective Repeat (buffering receiver, per-segment ACKs and timers) and TCP (cumulative ACKs, buffering receiver, one timer, fast retransmit on three duplicate ACKs). 10 tests: message order of handshake and teardown; no loss → each segment once, data right after the SYN-ACK; one lost segment → Go-Back-N resends 3–6, Selective Repeat only 3; TCP's fast retransmit comes before the timeout and finishes sooner than Go-Back-N; a lost cumulative ACK is covered by the next; Go-Back-N buffers nothing; under 25% random loss (25 seeds × 3 protocols) every segment is delivered exactly once in order, the window is never exceeded and the connection closes. Page: a sequence diagram (in-flight arrows, losses as ✕, retransmissions dashed), the client's window and the server's received/buffered segments, and the three protocols compared on the same losses.
  - **Found by testing**: a test asserting "Selective Repeat never resends more than Go-Back-N" failed — the premise was wrong twice: random losses differ between runs (the protocols send different numbers of messages), and a lost ACK *does* cost Selective Repeat a resend that a cumulative ACK would cover. Both facts now have deterministic tests, and the page asks about the second one.
  - **Found by using it**: a type error made the dev rebuild fail *after* it had emptied `dist/`, so the page went to 404 — the "keep serving the last good build" promise was false. Dev rebuilds no longer clean first and tsc runs with `noEmitOnError`; only `npm run build` starts from an empty folder. Labels of two messages sent from the same side in the same tick overlapped — now stacked.
- [ ] B+ tree, TCP connection, B+ tree, transactions, consistent
  hashing, Raft — then five polishing rounds.
