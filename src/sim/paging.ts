// Page replacement: which page to evict when memory is full and a new page is needed.
//
// A process touches pages in some order (the "reference string"). Memory holds `frames` pages. A
// reference to a page in memory is a hit; otherwise it is a page fault, and if memory is full one page
// must go. The policy decides which. Every policy here is deterministic, so a run can be stepped
// through and tested exactly.

export type Policy = "FIFO" | "LRU" | "OPT" | "Clock";

export const POLICIES: readonly Policy[] = ["FIFO", "LRU", "OPT", "Clock"];

export interface PagingStep {
  /** Index into the reference string. */
  time: number;
  /** The page referenced at this step. */
  page: number;
  hit: boolean;
  /** The page evicted to make room, if any. */
  evicted: number | null;
  /** Frame contents after this step (null = empty). Frame positions are stable, as in hardware. */
  frames: (number | null)[];
  /** Clock only: the reference bit of each frame and the hand position after this step. */
  refBits?: boolean[];
  hand?: number;
  /** Total faults so far, including this step. */
  faults: number;
  /** One sentence on what happened and why. */
  note: string;
}

export function simulate(refs: readonly number[], frameCount: number, policy: Policy): PagingStep[] {
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new RangeError("frameCount must be a positive integer");
  const frames: (number | null)[] = Array(frameCount).fill(null);
  const loadedAt: number[] = Array(frameCount).fill(-1); // FIFO: when each frame was filled
  const lastUsed: number[] = Array(frameCount).fill(-1); // LRU: when each frame was last referenced
  const refBits: boolean[] = Array(frameCount).fill(false); // Clock
  let hand = 0;
  let faults = 0;
  const steps: PagingStep[] = [];

  refs.forEach((page, time) => {
    const at = frames.indexOf(page);
    let evicted: number | null = null;
    let note: string;
    if (at >= 0) {
      lastUsed[at] = time;
      refBits[at] = true;
      note = `Page ${page} is in frame ${at}: a hit.`;
      steps.push(snapshot(true));
      return;
    }
    faults++;
    const empty = frames.indexOf(null);
    let slot: number;
    if (empty >= 0) {
      slot = empty;
      note = `Page ${page} is not in memory: a fault. Frame ${slot} is free.`;
    } else {
      slot = chooseVictim(time);
      evicted = frames[slot] as number;
      note = `Page ${page} is not in memory: a fault. ${policy} evicts page ${evicted} from frame ${slot} — ${reason(slot, time)}.`;
    }
    frames[slot] = page;
    loadedAt[slot] = time;
    lastUsed[slot] = time;
    refBits[slot] = true;
    if (policy === "Clock") hand = (slot + 1) % frameCount;
    steps.push(snapshot(false));

    function snapshot(hit: boolean): PagingStep {
      return {
        time, page, hit, evicted, frames: [...frames], faults, note,
        ...(policy === "Clock" ? { refBits: [...refBits], hand } : {}),
      };
    }
  });
  return steps;

  function chooseVictim(time: number): number {
    switch (policy) {
      case "FIFO":
        return argMin(loadedAt);
      case "LRU":
        return argMin(lastUsed);
      case "OPT": {
        // The page whose next use is furthest in the future (or never): the best any policy can do,
        // but it needs to know the future — useful as a yardstick, impossible in a real kernel.
        const nextUse = frames.map((p) => {
          const next = refs.indexOf(p as number, time + 1);
          return next < 0 ? Infinity : next;
        });
        return argMax(nextUse);
      }
      case "Clock": {
        // Sweep the hand: a frame with its reference bit set gets a second chance (bit cleared);
        // the first frame found with the bit clear is the victim.
        while (refBits[hand]) {
          refBits[hand] = false;
          hand = (hand + 1) % frameCount;
        }
        return hand;
      }
    }
  }

  function reason(slot: number, time: number): string {
    switch (policy) {
      case "FIFO":
        return `it has been in memory longest (since step ${loadedAt[slot]! + 1})`;
      case "LRU":
        return `it was used least recently (at step ${lastUsed[slot]! + 1})`;
      case "OPT": {
        const next = refs.indexOf(frames[slot] as number, time + 1);
        return next < 0 ? "it is never used again" : `it is next needed furthest away (at step ${next + 1})`;
      }
      case "Clock":
        return "the hand found its reference bit clear";
    }
  }
}

/** Number of page faults for the whole reference string. */
export function countFaults(refs: readonly number[], frameCount: number, policy: Policy): number {
  return simulate(refs, frameCount, policy).at(-1)?.faults ?? 0;
}

/** Parse "7 0 1 2, 0 3" into [7, 0, 1, 2, 0, 3]; throws on anything that is not a non-negative integer. */
export function parseReferenceString(text: string): number[] {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  return parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) throw new SyntaxError(`"${p}" is not a page number (0–999)`);
    return Number(p);
  });
}

/** The textbook reference string on which FIFO gets *more* faults with more memory. */
export const BELADY = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5] as const;

function argMin(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < xs[best]!) best = i;
  return best;
}

function argMax(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > xs[best]!) best = i;
  return best;
}
