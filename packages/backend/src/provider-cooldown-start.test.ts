import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRegistry } from "@terno/mail";
import { decodeCooldown, encodeCooldown } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("a Gmail pause the clock check held (plan 62)", () => {
  it("a start lifts a saved clock hold, re-waiting its full pause from now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-clock-hold-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const providers: ProviderRegistry = { create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }), async verifyImap() {}, connectGmail: async () => { throw new Error("unused"); } };
    const open = () => new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers, autoSync: false, now: () => 50_000 });
    const first = open();
    await first.ready;
    const held = { owner: "installation", service: "gmail-api", revision: "4", phaseRevision: "4", minimum: "40000", wall: "10000", replay: "30000", sample: 30000, position: 4, hold: "clock", repair: null };
    await first.store.providerCooldown.update(() => ({ encoded: encodeCooldown({ version: 1, revision: "4", overflow: false, bindings: [], rows: [held as never] }), result: undefined }));
    await first.stop();
    const again = open();
    cleanups.push(() => again.stop());
    await again.ready;
    const row = decodeCooldown(await again.store.providerCooldown.read()).rows[0]!;
    // no longer held, and not released early: the whole 30 s again from this start
    expect(row).toMatchObject({ hold: null, repair: "4", wall: "50000", replay: "30000" });
    expect(again["cooldown"]!.state("installation", "gmail-api")).toMatchObject({ kind: "at" });
  });

  it("65 saved holds are all lifted without overflowing the gate, and the log says the real wait (Codex review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-clock-holds-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const providers: ProviderRegistry = { create: () => ({ async verify() {}, async sync() {}, async execute() {}, async close() {} }), async verifyImap() {}, connectGmail: async () => { throw new Error("unused"); } };
    const logs: string[] = [];
    const open = () => new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers, autoSync: false, now: () => 50_000, log: (_level, message) => void logs.push(message) });
    const first = open();
    await first.ready;
    const rows = Array.from({ length: 65 }, (_, i) => ({ owner: i.toString(16).padStart(64, "0"), service: "gmail-api", revision: "1", phaseRevision: "1", minimum: "40000", wall: "10000", replay: "30000", sample: 30000, position: 4, hold: "clock", repair: null }));
    await first.store.providerCooldown.update(() => ({ encoded: encodeCooldown({ version: 1, revision: "1", overflow: false, bindings: [], rows: rows as never }), result: undefined }));
    await first.stop();
    const again = open();
    cleanups.push(() => again.stop());
    await again.ready;
    const ledger = decodeCooldown(await again.store.providerCooldown.read());
    expect(ledger.overflow).toBe(false);
    expect(ledger.rows.filter((row) => row.hold !== null)).toEqual([]);
    expect(again["cooldown"]!.state(rows[64]!.owner, "gmail-api")).toMatchObject({ kind: "at" });
    // the full 30 s pause from this start, not the stale wall minimum (already past)
    expect(logs.find((line) => line.includes("were lifted"))).toMatch(/65 Google pause\(s\) .* resume in 30 s/);
  });
});
