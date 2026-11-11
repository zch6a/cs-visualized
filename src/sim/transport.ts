// Reliable delivery over a network that loses packets: the TCP handshake, a sliding window of data,
// retransmission, and the teardown — tick by tick.
//
// The model: a client sends `segments` data segments to a server. Every message takes `delay` ticks one
// way. The client puts at most one segment on the wire per tick; ACKs are small and leave as soon as
// they are made. The handshake and teardown are not lost (to keep every run finite); data segments and
// ACKs can be — on their first transmission, by choice, or at random.
//
// Three ways to recover from loss:
// * Go-Back-N: the receiver keeps only in-order data and ACKs cumulatively ("next I need is n"); on a
//   timeout the sender resends everything from the oldest unacknowledged segment on.
// * Selective Repeat: the receiver buffers out-of-order data and ACKs each segment; the sender times
//   each segment separately and resends only what was lost.
// * TCP: cumulative ACKs like Go-Back-N, a buffering receiver like Selective Repeat, one timer — and
//   fast retransmit: three duplicate ACKs say "segment n is missing" well before any timeout.

export type Protocol = "Go-Back-N" | "Selective Repeat" | "TCP";
export const PROTOCOLS: readonly Protocol[] = ["Go-Back-N", "Selective Repeat", "TCP"];

export type Kind = "SYN" | "SYN-ACK" | "ACK" | "DATA" | "FIN";

export interface Message {
  id: number;
  kind: Kind;
  from: "client" | "server";
  /** DATA: segment number. */
  seq?: number;
  /** ACK during data transfer: cumulative ("next expected") or, in Selective Repeat, the segment acked. */
  ack?: number;
  sent: number;
  arrives: number;
  lost: boolean;
  retransmission: boolean;
  /** Short label for drawing, e.g. "DATA 3", "ACK 4". */
  label: string;
}

export interface Config {
  protocol: Protocol;
  segments: number;
  window: number;
  delay: number;
  /** Ticks before an unacknowledged segment is resent. */
  timeout: number;
  /** Data segments lost on their first transmission. */
  dropData?: number[];
  /** ACK numbers lost the first time they are sent. */
  dropAcks?: number[];
  /** Probability that any data segment or ACK is lost, with a seed (0 = none). */
  lossRate?: number;
  seed?: number;
}

export interface Frame {
  time: number;
  /** Every message sent so far (drawing filters by time). */
  messages: Message[];
  /** Sender: oldest unacknowledged segment, next new segment, and which are acknowledged. */
  base: number;
  next: number;
  acked: boolean[];
  /** Receiver: segments delivered to the application, in order, and segments buffered out of order. */
  delivered: number[];
  buffered: number[];
  phase: "handshake" | "data" | "teardown" | "closed";
  note: string;
}

export interface Run {
  frames: Frame[];
  messages: Message[];
  transmissions: number;
  retransmissions: number;
  finishedAt: number;
}

export function simulate(c: Config): Run {
  validate(c);
  const { protocol, segments: N, window: W, delay: D, timeout: T } = c;
  const messages: Message[] = [];
  const frames: Frame[] = [];
  const dropData = new Set(c.dropData ?? []);
  const dropAcks = new Set(c.dropAcks ?? []);
  const seenData = new Set<number>();
  const seenAcks = new Set<number>();
  let rng = (c.seed ?? 1) * 2654435761 % 2 ** 31 || 1;
  const random = () => ((rng = (rng * 48271) % 2147483647), rng / 2147483647);

  // Sender state
  let base = 0;
  let next = 0;
  const acked: boolean[] = Array(N).fill(false);
  const lastSent: number[] = Array(N).fill(-1);
  let timerFrom = -1; // Go-Back-N / TCP: when the single timer was (re)started; -1 = stopped
  const resend: number[] = []; // segments queued for retransmission
  let dupAcks = 0;
  let fastRetransmitted = -1;
  // Receiver state
  let expected = 0;
  const buffer = new Set<number>();
  const delivered: number[] = [];
  // Connection state
  let phase: Frame["phase"] = "handshake";
  const current = (): Frame["phase"] => phase; // read through a function: callbacks change it
  let finishedAt = -1;
  let transmissions = 0;
  let retransmissions = 0;

  send("client", "SYN", 0, {});
  for (let t = 0; finishedAt < 0 || t <= finishedAt; t++) {
    if (t > 5000) throw new Error("the transfer did not finish within 5,000 ticks — too much loss for this timeout and window");
    const notes: string[] = [];
    if (t === finishedAt) phase = "closed";
    // 1. Arrivals.
    for (const m of messages.filter((m) => m.arrives === t)) {
      if (m.lost) {
        notes.push(`${m.label} was lost on the way`);
        continue;
      }
      receive(m, t, notes);
    }
    // 2. Timeouts.
    if (current() === "data") {
      if (protocol === "Selective Repeat") {
        for (let s = base; s < next; s++) {
          if (!acked[s] && lastSent[s]! >= 0 && t - lastSent[s]! >= T && !resend.includes(s)) {
            resend.push(s);
            lastSent[s] = t; // the segment's own timer restarts when it is resent
            notes.push(`timer for segment ${s} expires: resend it alone`);
          }
        }
      } else if (timerFrom >= 0 && t - timerFrom >= T && base < next) {
        if (protocol === "Go-Back-N") {
          for (let s = base; s < next; s++) if (!resend.includes(s)) resend.push(s);
          notes.push(`timeout: go back to segment ${base} and resend all ${next - base} unacknowledged`);
        } else {
          if (!resend.includes(base)) resend.push(base);
          notes.push(`timeout: resend segment ${base}`);
        }
        timerFrom = t;
        dupAcks = 0;
      }
    }
    // 3. The client puts at most one data segment on the wire.
    if (current() === "data") {
      const s = resend.shift();
      if (s !== undefined) {
        sendData(s, t, true);
        notes.push(`resend segment ${s}`);
      } else if (next < N && next < base + W) {
        sendData(next, t, false);
        notes.push(`send segment ${next} (window ${base}–${base + W - 1})`);
        next++;
      }
    }
    frames.push({
      time: t,
      messages: messages.filter((m) => m.sent <= t),
      base, next, acked: [...acked], delivered: [...delivered], buffered: [...buffer].sort((a, b) => a - b),
      phase,
      note: `t=${t}: ${notes.length ? notes.join("; ") : phaseNote()}.`,
    });
  }
  return { frames, messages, transmissions, retransmissions, finishedAt };

  function phaseNote(): string {
    if (phase === "handshake") return "the handshake is in flight";
    if (phase === "data") return base < next ? `waiting for ACKs (window ${base}–${base + W - 1} is full or the data is all sent)` : "nothing to send";
    if (phase === "teardown") return "closing";
    return "closed";
  }

  function send(from: "client" | "server", kind: Kind, t: number, extra: { seq?: number; ack?: number; retransmission?: boolean }): Message {
    const label = kind === "DATA" ? `DATA ${extra.seq}` : kind === "ACK" && extra.ack !== undefined ? `ACK ${extra.ack}` : kind;
    let lost = false;
    if (kind === "DATA") {
      lost = (dropData.has(extra.seq!) && !seenData.has(extra.seq!)) || (!!c.lossRate && random() < c.lossRate);
      seenData.add(extra.seq!);
    } else if (kind === "ACK" && extra.ack !== undefined) {
      lost = (dropAcks.has(extra.ack) && !seenAcks.has(extra.ack)) || (!!c.lossRate && random() < c.lossRate);
      seenAcks.add(extra.ack);
    }
    const m: Message = { id: messages.length, kind, from, sent: t, arrives: t + D, lost, retransmission: !!extra.retransmission, label, ...(extra.seq !== undefined ? { seq: extra.seq } : {}), ...(extra.ack !== undefined ? { ack: extra.ack } : {}) };
    messages.push(m);
    return m;
  }

  function sendData(s: number, t: number, again: boolean): void {
    send("client", "DATA", t, { seq: s, retransmission: again });
    transmissions++;
    if (again) retransmissions++;
    lastSent[s] = t;
    if (protocol !== "Selective Repeat" && (timerFrom < 0 || s === base && again)) timerFrom = t;
  }

  function receive(m: Message, t: number, notes: string[]): void {
    switch (m.kind) {
      case "SYN":
        send("server", "SYN-ACK", t, {});
        notes.push("server gets SYN, answers SYN-ACK");
        return;
      case "SYN-ACK":
        send("client", "ACK", t, {});
        phase = "data";
        notes.push("client gets SYN-ACK, sends ACK: connection open (data may follow right away)");
        return;
      case "FIN":
        if (m.from === "client") {
          send("server", "ACK", t, {});
          send("server", "FIN", t, {});
          notes.push("server gets FIN: ACKs it and sends its own FIN");
        } else {
          send("client", "ACK", t, {});
          finishedAt = t + D;
          notes.push("client gets the server's FIN and ACKs it: the connection is closed once that ACK lands");
        }
        return;
      case "ACK":
        if (m.ack === undefined) {
          if (m.from === "server" && phase === "teardown") notes.push("the server's ACK of the client's FIN arrives");
          if (m.from === "client" && phase === "closed") notes.push("the client's last ACK arrives: both sides are closed");
          return;
        }
        if (m.from === "server") onAck(m.ack, t, notes);
        return;
      case "DATA":
        onData(m.seq!, t, notes);
        return;
    }
  }

  function onData(s: number, t: number, notes: string[]): void {
    if (protocol === "Go-Back-N") {
      if (s === expected) {
        delivered.push(s);
        expected++;
        notes.push(`server gets segment ${s} in order: delivers it`);
      } else notes.push(`server gets segment ${s} but needs ${expected}: discards it`);
      send("server", "ACK", t, { ack: expected });
      return;
    }
    if (s >= expected && s < expected + W) buffer.add(s);
    const before = expected;
    while (buffer.has(expected)) {
      buffer.delete(expected);
      delivered.push(expected);
      expected++;
    }
    if (expected > before) notes.push(`server delivers ${before === expected - 1 ? `segment ${before}` : `segments ${before}–${expected - 1}`}`);
    else if (s >= expected) notes.push(`server buffers segment ${s} (still missing ${expected})`);
    else notes.push(`server already has segment ${s}`);
    send("server", "ACK", t, { ack: protocol === "Selective Repeat" ? s : expected });
  }

  function onAck(a: number, t: number, notes: string[]): void {
    if (phase !== "data") return;
    if (protocol === "Selective Repeat") {
      if (a < N && !acked[a]) {
        acked[a] = true;
        notes.push(`client gets ACK ${a}`);
        while (base < N && acked[base]) base++;
      }
    } else if (a > base) {
      for (let s = base; s < a; s++) acked[s] = true;
      base = a;
      dupAcks = 0;
      timerFrom = base < next ? t : -1;
      for (let i = resend.length - 1; i >= 0; i--) if (resend[i]! < base) resend.splice(i, 1);
      notes.push(`client gets ACK ${a}: everything before ${a} has arrived`);
    } else if (a === base && base < next) {
      dupAcks++;
      notes.push(`client gets a duplicate ACK ${a} (${dupAcks})`);
      if (protocol === "TCP" && dupAcks === 3 && fastRetransmitted !== base) {
        fastRetransmitted = base;
        if (!resend.includes(base)) resend.unshift(base);
        notes.push(`three duplicate ACKs: fast retransmit of segment ${base}, without waiting for the timer`);
      }
    }
    if (base >= N) {
      phase = "teardown";
      send("client", "FIN", t, {});
      notes.push("all data acknowledged: client sends FIN");
    }
  }
}

function validate(c: Config): void {
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be a whole number from ${lo} to ${hi}`);
  };
  int(c.segments, 1, 40, "segments");
  int(c.window, 1, 20, "window");
  int(c.delay, 1, 10, "delay");
  int(c.timeout, 2 * c.delay, 100, "timeout");
  if (c.lossRate !== undefined && !(c.lossRate >= 0 && c.lossRate <= 0.5)) throw new RangeError("loss rate must be between 0 and 0.5");
  if (c.seed !== undefined) int(c.seed, 1, 1_000_000, "seed");
}
