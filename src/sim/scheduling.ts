// CPU scheduling: which ready process runs next.
//
// Time moves in whole ticks. Each process arrives at some tick and needs some number of ticks of CPU
// (its burst). The scheduler picks one ready process per tick. The policies differ only in that choice
// — and in whether they may take the CPU away from a process that has not finished (preemption).

export type Algorithm = "FCFS" | "SJF" | "SRTF" | "RR" | "MLFQ";

export const ALGORITHMS: readonly Algorithm[] = ["FCFS", "SJF", "SRTF", "RR", "MLFQ"];

export interface Process {
  name: string;
  arrival: number;
  burst: number;
}

export interface Options {
  /** Round robin's time slice. */
  quantum?: number;
  /** MLFQ: the time slice of each level (the last level runs to completion). */
  levels?: number[];
  /** MLFQ: every this many ticks, move every process back to the top queue (0 = never). */
  boost?: number;
}

export interface Tick {
  time: number;
  /** Who ran during [time, time + 1), or null if the CPU was idle. */
  running: string | null;
  /** Ready processes waiting, in queue order (MLFQ: one list per level). */
  queues: string[][];
  /** CPU time each process still needs, after this tick. */
  remaining: Record<string, number>;
  /** What happened, in a sentence. */
  note: string;
}

export interface Result {
  ticks: Tick[];
  /** Per process: completion time, turnaround (completion − arrival), waiting (turnaround − burst),
   *  response (first run − arrival). */
  stats: Record<string, { completion: number; turnaround: number; waiting: number; response: number }>;
  average: { turnaround: number; waiting: number; response: number };
}

export function schedule(processes: readonly Process[], algorithm: Algorithm, options: Options = {}): Result {
  validate(processes);
  const quantum = options.quantum ?? 4;
  const levels = options.levels ?? [2, 4];
  const boost = options.boost ?? 0;
  if (!Number.isInteger(quantum) || quantum < 1) throw new RangeError("quantum must be a positive integer");

  const order = new Map(processes.map((p, i) => [p.name, i]));
  const remaining: Record<string, number> = Object.fromEntries(processes.map((p) => [p.name, p.burst]));
  const firstRun: Record<string, number> = {};
  const completion: Record<string, number> = {};
  const levelCount = algorithm === "MLFQ" ? levels.length + 1 : 1;
  const queues: string[][] = Array.from({ length: levelCount }, () => []);
  const levelOf: Record<string, number> = {};
  const arrival = (name: string) => processes[order.get(name)!]!.arrival;
  const burst = (name: string) => processes[order.get(name)!]!.burst;

  let running: string | null = null;
  let used = 0; // ticks the running process has had in its current slice
  let requeue: string | null = null; // a process whose slice ended last tick, to go back after arrivals
  const ticks: Tick[] = [];
  const total = processes.reduce((n, p) => n + p.burst, 0);
  let done = 0;

  for (let time = 0; done < processes.length; time++) {
    if (time > 100_000) throw new Error("simulation did not finish");
    const events: string[] = [];
    // 1. Arrivals join the (top) queue, in input order.
    for (const p of processes) {
      if (p.arrival === time) {
        queues[0]!.push(p.name);
        levelOf[p.name] = 0;
        events.push(`${p.name} arrives`);
      }
    }
    // 2. MLFQ priority boost: everyone back to the top, so long jobs cannot starve.
    if (algorithm === "MLFQ" && boost > 0 && time > 0 && time % boost === 0) {
      const all = [...queues.flat(), ...(requeue ? [requeue] : []), ...(running ? [running] : [])];
      if (all.length) {
        for (const q of queues) q.length = 0;
        queues[0]!.push(...all);
        for (const n of all) levelOf[n] = 0;
        if (running) used = 0;
        running = null;
        requeue = null;
        events.push("priority boost: every process back to the top queue");
      }
    }
    // 3. A process whose time slice ran out goes to the back — behind this tick's arrivals.
    if (requeue) {
      queues[levelOf[requeue]!]!.push(requeue);
      requeue = null;
    }
    // 4. Choose who runs this tick.
    const before: string | null = running;
    running = choose(events);
    if (running !== before && running !== null && before === null) used = 0;
    if (running !== null) {
      firstRun[running] ??= time;
      remaining[running]! -= 1;
      used++;
    }
    const ranNow = running;
    // 5. After the tick: finished, or slice expired?
    if (running !== null && remaining[running] === 0) {
      completion[running] = time + 1;
      done++;
      events.push(`${running} finishes at ${time + 1}`);
      running = null;
      used = 0;
    } else if (running !== null && sliceOf(running) !== Infinity && used >= sliceOf(running)) {
      if (algorithm === "MLFQ" && levelOf[running]! < levelCount - 1) {
        levelOf[running]! += 1;
        events.push(`${running} used its whole slice: down to queue ${levelOf[running]}`);
      } else {
        events.push(`${running}'s time slice ends`);
      }
      requeue = running;
      running = null;
      used = 0;
    }
    ticks.push({
      time,
      running: ranNow,
      queues: queues.map((q) => [...q]),
      remaining: { ...remaining },
      note: describe(time, ranNow, events),
    });
  }
  if (ticks.filter((t) => t.running).length !== total) throw new Error("internal error: CPU time does not add up");

  const stats: Result["stats"] = {};
  for (const p of processes) {
    const turnaround = completion[p.name]! - p.arrival;
    stats[p.name] = { completion: completion[p.name]!, turnaround, waiting: turnaround - p.burst, response: firstRun[p.name]! - p.arrival };
  }
  const mean = (k: "turnaround" | "waiting" | "response") => processes.reduce((s, p) => s + stats[p.name]![k], 0) / processes.length;
  return { ticks, stats, average: { turnaround: mean("turnaround"), waiting: mean("waiting"), response: mean("response") } };

  function sliceOf(name: string): number {
    if (algorithm === "RR") return quantum;
    if (algorithm === "MLFQ") return levels[levelOf[name]!] ?? Infinity;
    return Infinity;
  }

  /** Pick the process for this tick; the current one keeps the CPU unless the policy preempts it. */
  function choose(events: string[]): string | null {
    const take = (q: string[], name: string) => q.splice(q.indexOf(name), 1)[0]!;
    switch (algorithm) {
      case "FCFS":
      case "RR":
        if (running) return running;
        return queues[0]!.shift() ?? null;
      case "SJF": {
        if (running) return running; // non-preemptive: runs to completion
        const next = minBy(queues[0]!, (n) => burst(n));
        return next ? take(queues[0]!, next) : null;
      }
      case "SRTF": {
        const candidates = running ? [running, ...queues[0]!] : queues[0]!;
        const next = minBy(candidates, (n) => remaining[n]!);
        if (next === undefined) return null;
        if (running && next !== running) {
          events.push(`${next} needs less time (${remaining[next]}) than ${running} has left (${remaining[running]}): preempt`);
          queues[0]!.push(running);
          used = 0;
        }
        return next === running ? running : take(queues[0]!, next);
      }
      case "MLFQ": {
        const top = queues.findIndex((q) => q.length > 0);
        if (running) {
          if (top >= 0 && top < levelOf[running]!) {
            events.push(`${queues[top]![0]} in queue ${top} preempts ${running} (queue ${levelOf[running]})`);
            queues[levelOf[running]!]!.unshift(running); // keeps its place at the front of its level
            used = 0;
          } else return running;
        }
        const level = queues.findIndex((q) => q.length > 0);
        return level >= 0 ? queues[level]!.shift()! : null;
      }
    }

    function minBy(names: string[], key: (n: string) => number): string | undefined {
      // Ties: earlier arrival, then input order — the usual textbook convention.
      return [...names].sort((a, b) => key(a) - key(b) || arrival(a) - arrival(b) || order.get(a)! - order.get(b)!)[0];
    }
  }
}

function describe(time: number, running: string | null, events: string[]): string {
  const what = running ? `${running} runs` : "the CPU is idle";
  return `t=${time}: ${what}${events.length ? ` — ${events.join("; ")}` : ""}.`;
}

function validate(processes: readonly Process[]): void {
  if (processes.length === 0) throw new RangeError("no processes");
  const names = new Set<string>();
  for (const p of processes) {
    if (!p.name || names.has(p.name)) throw new RangeError(`process names must be unique and non-empty ("${p.name}")`);
    names.add(p.name);
    if (!Number.isInteger(p.arrival) || p.arrival < 0) throw new RangeError(`${p.name}: arrival must be a whole number ≥ 0`);
    if (!Number.isInteger(p.burst) || p.burst < 1) throw new RangeError(`${p.name}: burst must be a whole number ≥ 1`);
  }
}

/** Parse lines like "P1 0 8" (name, arrival, burst). */
export function parseProcesses(text: string): Process[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((line) => {
    const parts = line.split(/[\s,]+/);
    if (parts.length !== 3) throw new SyntaxError(`"${line}": expected name, arrival time and burst`);
    const [name, arrival, burst] = parts as [string, string, string];
    if (!/^\d+$/.test(arrival) || !/^\d+$/.test(burst)) throw new SyntaxError(`"${line}": arrival and burst must be whole numbers`);
    return { name, arrival: Number(arrival), burst: Number(burst) };
  });
}
