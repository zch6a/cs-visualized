import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PROTOCOLS, simulate, type Config } from "../src/sim/transport.ts";

const base: Config = { protocol: "Go-Back-N", segments: 10, window: 4, delay: 3, timeout: 10 };
const resent = (c: Config) => simulate(c).messages.filter((m) => m.kind === "DATA" && m.retransmission).map((m) => m.seq);

test("handshake and teardown happen in the right order", () => {
  const kinds = simulate(base).messages.filter((m) => m.kind !== "DATA" && m.ack === undefined).map((m) => `${m.from}:${m.kind}`);
  assert.deepEqual(kinds.slice(0, 3), ["client:SYN", "server:SYN-ACK", "client:ACK"]);
  assert.deepEqual(kinds.slice(3), ["client:FIN", "server:ACK", "server:FIN", "client:ACK"]);
});

test("without loss every protocol sends each segment once, and data starts after one round trip", () => {
  for (const protocol of PROTOCOLS) {
    const run = simulate({ ...base, protocol });
    assert.equal(run.transmissions, 10);
    assert.equal(run.retransmissions, 0);
    assert.equal(run.messages.find((m) => m.kind === "DATA")!.sent, 2 * base.delay, "first data right after the SYN-ACK arrives");
    assert.deepEqual(run.frames.at(-1)!.delivered, [...Array(10).keys()]);
  }
});

test("one lost segment: Go-Back-N resends the whole window after it, Selective Repeat only the segment", () => {
  assert.deepEqual(resent({ ...base, dropData: [3] }), [3, 4, 5, 6]);
  assert.deepEqual(resent({ ...base, protocol: "Selective Repeat", dropData: [3] }), [3]);
});

test("TCP's fast retransmit recovers before the timer would", () => {
  const cfg: Config = { ...base, protocol: "TCP", timeout: 20, dropData: [3] };
  const run = simulate(cfg);
  assert.deepEqual(resent(cfg), [3]);
  const firstSend = run.messages.find((m) => m.seq === 3)!.sent;
  const resend = run.messages.find((m) => m.seq === 3 && m.retransmission)!.sent;
  assert.ok(resend - firstSend < cfg.timeout, `resent after ${resend - firstSend} ticks, timeout is ${cfg.timeout}`);
  assert.ok(run.frames.some((f) => /fast retransmit/.test(f.note)));
  // ...and so it finishes sooner than Go-Back-N with the same loss and timer.
  assert.ok(run.finishedAt < simulate({ ...cfg, protocol: "Go-Back-N" }).finishedAt);
});

test("a lost cumulative ACK costs nothing when a later ACK covers it", () => {
  const run = simulate({ ...base, dropAcks: [2] });
  assert.equal(run.retransmissions, 0);
});

test("Go-Back-N's receiver discards out-of-order data; the others buffer it", () => {
  const gbn = simulate({ ...base, dropData: [2] });
  assert.ok(gbn.frames.every((f) => f.buffered.length === 0));
  const sr = simulate({ ...base, protocol: "Selective Repeat", dropData: [2] });
  assert.ok(sr.frames.some((f) => f.buffered.includes(3)));
});

test("under random loss, every protocol delivers every segment exactly once, in order", () => {
  for (const protocol of PROTOCOLS) {
    for (let seed = 1; seed <= 25; seed++) {
      const run = simulate({ protocol, segments: 20, window: 5, delay: 2, timeout: 8, lossRate: 0.25, seed });
      const last = run.frames.at(-1)!;
      assert.deepEqual(last.delivered, [...Array(20).keys()], `${protocol} seed ${seed}`);
      assert.equal(last.phase, "closed");
      // The sender never has more than a window of unacknowledged segments outstanding.
      for (const f of run.frames) assert.ok(f.next - f.base <= 5);
      assert.equal(run.transmissions - run.retransmissions, 20);
    }
  }
});

test("with lost data, Selective Repeat resends only what was lost; Go-Back-N resends more", () => {
  const cfg: Config = { ...base, segments: 20, window: 6, dropData: [2, 9, 15] };
  assert.deepEqual(resent({ ...cfg, protocol: "Selective Repeat" }), [2, 9, 15]);
  assert.ok(simulate(cfg).retransmissions > 3);
});

test("but a lost ACK costs Selective Repeat a resend that cumulative ACKs avoid", () => {
  // Selective Repeat ACKs each segment by itself, so nothing later can stand in for a lost one.
  assert.deepEqual(resent({ ...base, protocol: "Selective Repeat", dropAcks: [2] }), [2]);
  assert.deepEqual(resent({ ...base, protocol: "Go-Back-N", dropAcks: [3] }), []);
});

test("validation", () => {
  assert.throws(() => simulate({ ...base, segments: 0 }), RangeError);
  assert.throws(() => simulate({ ...base, timeout: 5 }), /timeout/); // shorter than a round trip
  assert.throws(() => simulate({ ...base, lossRate: 0.9 }), RangeError);
});
