import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SqlMailStore, openDatabase } from "@terno/db";
import { msg } from "../../store/src/conformance/fixtures";
import { watchLoop } from "../../db/src/test/timing";
import { createNodeIncomingProcessor } from "./incoming-worker";

it("measures bounded current parse/transfer/clone/native store costs without choosing a policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-text-policy-"));
  const store = new SqlMailStore(openDatabase(join(dir, "test.db")));
  const worker = createNodeIncomingProcessor();
  try {
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", now: 1 });
    await store.sync.ingest(Array.from({ length: 500 }, () => msg({ accountId: account.id })), { applyFilters: false, now: 1, classifier: null });
    for (const value of ["missing one", "missing two", "missing three", "missing four"]) await store.filters.save({ name: "synthetic", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value }], actions: [{ type: "archive" }] } }, 1);
    const records: unknown[] = [];
    for (const shape of ["words", "combining", "unbroken", "html"] as const) {
      for (const kib of [64, 128, 256, 512]) {
        const unit = shape === "words" ? "alpha beta gamma " : shape === "combining" ? "e\u0301 alpha " : shape === "html" ? "<p>alpha e\u0301 &amp; beta</p>\n" : "x";
        const body = unit.repeat(Math.ceil(kib * 1024 / unit.length)).slice(0, kib * 1024);
        const raw = `Subject: synthetic\r\nContent-Type: text/${shape === "html" ? "html" : "plain"}; charset=utf-8\r\n\r\n${body}`;
        for (let sample = 0; sample < 3; sample++) {
          const chunks = [new TextEncoder().encode(raw)];
          const started = performance.now();
          const parsed = await worker.run({ kind: "mime", profile: "imap", chunks }, new AbortController().signal);
          const workerWall = performance.now() - started;
          const cloneStart = performance.now();
          const copied = structuredClone(parsed.message);
          const cloneWall = performance.now() - cloneStart;
          expect(copied.text === parsed.message.text && copied.html === parsed.message.html).toBe(true);
          const monitor = watchLoop(15);
          const cpu = process.threadCpuUsage();
          const before = performance.now();
          const result = await store.sync.ingest([msg({ accountId: account.id, bodyText: copied.text, bodyHtml: copied.html })], { applyFilters: true, now: 1, classifier: null });
          const used = process.threadCpuUsage(cpu);
          const storeWall = performance.now() - before;
          const timing = await monitor.stop();
          expect(result.opIds).toEqual([]);
          records.push({ shape, kib, sample, wire: new TextEncoder().encode(raw).byteLength, combined: (copied.text?.length ?? 0) + (copied.html?.length ?? 0), workerWall, cloneWall, storeWall, storeCpu: (used.user + used.system) / 1000, stall: timing.stall });
        }
      }
    }
    console.log(JSON.stringify({ qualification: "finite-native-500rows-4bodyfilters-no-warmup", records }));
  } finally { await worker.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([65536, 131072])("measures the exact proposed %s-unit boundary once, including cold workers", async (limit) => {
  const records: unknown[] = [];
  for (const shape of ["words", "combining", "unbroken", "html"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "terno-text-boundary-"));
    const store = new SqlMailStore(openDatabase(join(dir, "test.db")));
    const worker = createNodeIncomingProcessor();
    try {
      const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", now: 1 });
      await store.sync.ingest(Array.from({ length: 500 }, () => msg({ accountId: account.id })), { applyFilters: false, now: 1, classifier: null });
      for (const value of ["missing one", "missing two", "missing three", "missing four"]) await store.filters.save({ name: "synthetic", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value }], actions: [{ type: "archive" }] } }, 1);
      const unit = shape === "words" ? "alpha beta gamma " : shape === "combining" ? "e\u0301 alpha " : "x";
      const body = unit.repeat(Math.ceil((limit - 1) / unit.length)).slice(0, limit - 1);
      const html = `<p>${"alpha ".repeat(Math.ceil(limit / 12)).slice(0, limit / 2 - 7)}</p>`;
      const raw = shape === "html" ? `Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${body.slice(0, limit / 2)}\r\n--b\r\nContent-Type: text/html\r\n\r\n${html}\r\n--b--\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
      for (let sample = 0; sample < 3; sample++) {
        const start = performance.now();
        const parsed = await worker.run({ kind: "mime", profile: "imap", chunks: [new TextEncoder().encode(raw)] }, new AbortController().signal);
        const workerWall = performance.now() - start;
        const combined = (parsed.message.text?.length ?? 0) + (parsed.message.html?.length ?? 0);
        expect(combined).toBe(limit);
        const monitor = watchLoop(15), cpu = process.threadCpuUsage(), before = performance.now();
        await store.sync.ingest([msg({ accountId: account.id, bodyText: parsed.message.text, bodyHtml: parsed.message.html })], { applyFilters: true, now: 1, classifier: null });
        const used = process.threadCpuUsage(cpu), storeWall = performance.now() - before, timing = await monitor.stop();
        records.push({ shape, sample, combined, workerWall, storeWall, storeCpu: (used.user + used.system) / 1000, stall: timing.stall });
      }
    } finally { await worker.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ qualification: `exact-proposed-${limit}-unit-boundary`, records }));
});
