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
- [ ] CPU scheduling, TCP congestion control, TCP connection, B+ tree, transactions, consistent
  hashing, Raft — then five polishing rounds.
