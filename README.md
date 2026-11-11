# CS, visualized

**Computer science you can step through.** Interactive simulations of the ideas every engineer is taught
and few have watched happen — page replacement, TCP congestion control, B+ trees, Raft and more. Step
forward and back, change the input, and see exactly where the textbook answer comes from.

Every simulation is plain TypeScript with no DOM, tested against the numbers textbooks print (FIFO 15,
LRU 12, OPT 9 faults on Silberschatz's reference string) and against the properties that must hold
(OPT is never beaten; LRU never faults more with more memory; FIFO sometimes does).

## Topics

| Area | Topic | Status |
|---|---|---|
| Operating systems | Page replacement: FIFO, LRU, OPT, Clock, Bélády's anomaly | ✅ |
| Operating systems | CPU scheduling: FCFS, SJF, SRTF, round robin, MLFQ with boost | ✅ |
| Networking | TCP congestion control: slow start, AIMD, Tahoe vs Reno, why AIMD is fair | ✅ |
| Networking | Reliable delivery: handshake, sliding window, Go-Back-N, Selective Repeat, fast retransmit | ✅ |
| Databases | B+ tree: insert with splits, search, range scans along the leaf links | ✅ |
| Databases | Transactions: isolation levels and their anomalies | planned |
| Distributed systems | Consistent hashing: the ring, virtual nodes, rebalancing | planned |
| Distributed systems | Raft: leader election and log replication | planned |

## Run it

```bash
npm install          # TypeScript, for the build; the site itself has no dependencies
npm run dev          # build, serve on http://localhost:5173, rebuild on save
npm test             # the simulations' tests
```

Node 22.15 or newer. `npm run build` writes a static site to `dist/` that any web server can host.

## How it is built

- `src/sim/` — the simulations: pure functions from an input to a list of steps, each step a full
  snapshot plus a sentence explaining it. No DOM, so they run under `node --test`.
- `src/topics/` — one page per topic: controls, a drawing of the current step, and things to try.
- `src/ui/` — a step player (back, forward, play, scrub; arrow keys, space, Home/End) and tiny DOM helpers.
- No framework and no bundler: `tsc` compiles to ES modules the browser loads directly.

## License

MIT
