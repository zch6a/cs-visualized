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
- [ ] TCP congestion control, TCP connection, B+ tree, transactions, consistent
  hashing, Raft — then five polishing rounds.
