/**
 * Plan 29's parser gates: reading and repairing what other clients write
 * must stay linear and cheap (it runs on every message ingested and on
 * every thread opened). 5,000 nasty headers; a 2,000-recipient header and
 * eight times as many (the time may grow ~8×, never quadratically); the
 * fast path on clean stored addresses (what a thread read pays); a whole
 * parseRaw of a message with a 2,000-recipient mangled Cc. Each the best of
 * five rounds (a busy machine slows a round, a regression slows them all).
 */
import { parseAddressHeader, repairAddresses, type Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import { headerFields, messageAddresses, parseRaw } from "./mime";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const best = (rounds: number, run: () => void) => {
  let min = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t = performance.now();
    run();
    min = Math.min(min, performance.now() - t);
  }
  return min;
};

const NASTY = [
  '"=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>',
  "=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez <jp@x.com>, =?UTF-8?B?w4FuZ2Vs?= =?UTF-8?Q?_P=C3=A9rez?= <ap@x.com>",
  '"Unbalanced <u@x.com>, b@x.com, “Smart” <s@x.com>, \'Ana Torres\' <a@x.com>',
  "Team: a@x.com, b@y.com;, (Jane Doe) jane@x.com, <@relay:user@x.com>, <<d@x.com>>, mailto:m@x.com",
  "Outlook User [mailto:ol@x.com] <ol@x.com>, JosÃ© PÃ©rez <jp2@x.com>, undisclosed-recipients:;",
];
const list = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 ? `"Persona ${i}, Equipo" <p${i}@example.com>` : `=?UTF-8?Q?Persona_N=C3=BAmero_${i}?= <p${i}@example.com>`)).join(", ");

describe("address parsing gates (plan 29)", () => {
  it("5,000 nasty headers parse and repair in ≤ 150 ms", () => {
    const headers = Array.from({ length: 5000 }, (_, i) => NASTY[i % NASTY.length]!.replace(/@x\.com/g, `@x${i}.com`));
    const ms = best(5, () => {
      for (const h of headers) parseAddressHeader(h);
    });
    console.log(`5,000 nasty headers: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(150 * MULT);
  });

  it("IMAP's raw fields: 32,000 repeated Cc lines cost at most ~16× 4,000 (Codex code review 5: they were copied per line)", () => {
    const block = (n: number) => new TextEncoder().encode(Array.from({ length: n }, (_, i) => `Cc: p${i}@example.com\r\n`).join("") + "\r\n");
    const small = block(4000);
    const big = block(32_000);
    const s = best(5, () => messageAddresses(headerFields(small)));
    const b = best(5, () => messageAddresses(headerFields(big)));
    console.log(`4,000 Cc lines ${s.toFixed(1)} ms, 32,000 ${b.toFixed(1)} ms (×${(b / s).toFixed(1)})`);
    expect(messageAddresses(headerFields(big)).cc).toHaveLength(32_000);
    expect(b / s).toBeLessThanOrEqual(16 * MULT);
  });

  it("a header of 16,000 recipients costs at most ~16× one of 2,000 (linear: 8×; quadratic would be 64×)", () => {
    const small = list(2000);
    const big = list(16_000);
    const s = best(5, () => parseAddressHeader(small));
    const b = best(5, () => parseAddressHeader(big));
    console.log(`2,000 recipients ${s.toFixed(1)} ms, 16,000 ${b.toFixed(1)} ms (×${(b / s).toFixed(1)})`);
    expect(parseAddressHeader(big)).toHaveLength(16_000);
    expect(b / s).toBeLessThanOrEqual(16 * MULT);
  });

  it("clean stored addresses take the fast path: ≤ 0.5 µs each (a thread read)", () => {
    const clean: Address[] = Array.from({ length: 100_000 }, (_, i) => ({ name: i % 2 ? `José Pérez ${i}` : "", email: `p${i}@example.com` }));
    const ms = best(5, () => repairAddresses(clean));
    console.log(`100,000 clean addresses: ${ms.toFixed(1)} ms (${((ms * 1000) / clean.length).toFixed(3)} µs each)`);
    expect((ms * 1000) / clean.length).toBeLessThanOrEqual(0.5 * MULT);
  });

  it("parseRaw of a message with a 2,000-recipient mangled Cc stays within 3× the same message's parse without our pass", async () => {
    const raw = `From: Ana <ana@x.com>\r\nTo: me@mine.com\r\nCc: ${list(2000)}, ${NASTY[0]}\r\nSubject: s\r\nMessage-ID: <m@x>\r\n\r\nbody\r\n`;
    const PostalMime = (await import("postal-mime")).default;
    let theirs = Infinity;
    let ours = Infinity;
    for (let r = 0; r < 5; r++) {
      let t = performance.now();
      await PostalMime.parse(raw);
      theirs = Math.min(theirs, performance.now() - t);
      t = performance.now();
      const p = await parseRaw(raw);
      ours = Math.min(ours, performance.now() - t);
      expect(p.cc.length).toBe(2002);
    }
    console.log(`parseRaw with a 2,000-recipient Cc: ${ours.toFixed(1)} ms (postal-mime alone ${theirs.toFixed(1)} ms)`);
    expect(ours).toBeLessThanOrEqual(theirs * 3 * MULT + 5);
  });
});
