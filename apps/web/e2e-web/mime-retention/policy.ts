import { IdbMailStore, databaseName } from "@terno/idb";
import { msg } from "../../../../packages/store/src/conformance/fixtures";
import { webPlatform } from "../../src/web/worker/platform";
import { createBrowserIncomingProcessor } from "../../src/web/worker/incoming-runtime";

export async function measurePolicy(mode: "explore" | "boundary" | "boundary64" = "explore") {
    const name = `mime-policy-${crypto.randomUUID()}`;
    const store = await IdbMailStore.open({ name, factory: indexedDB, platform: webPlatform(undefined), instantSearch: false });
    const worker = createBrowserIncomingProcessor();
    const records: { shape: string; kib: number; sample: number; combined: number; workerWall: number; cloneWall: number; storeWall: number }[] = [];
    try {
      const { account } = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
      await store.sync.ingest(Array.from({ length: 500 }, () => msg({ accountId: account.id })), { applyFilters: false, now: 1, classifier: null });
      for (const value of ["missing one", "missing two", "missing three", "missing four"]) await store.filters.save({ name: "synthetic", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value }], actions: [{ type: "archive" }] } }, 1);
      for (const shape of ["words", "combining", "unbroken", "html"] as const) for (const kib of mode !== "explore" ? [128] : [64, 128, 256, 512]) {
        const unit = shape === "words" ? "alpha beta gamma " : shape === "combining" ? "e\u0301 alpha " : shape === "html" ? "<p>alpha e\u0301 &amp; beta</p>\n" : "x";
        const body = unit.repeat(Math.ceil(kib * 1024 / unit.length)).slice(0, kib * 1024);
        let raw = `Subject: synthetic\r\nContent-Type: text/${shape === "html" ? "html" : "plain"}; charset=utf-8\r\n\r\n${body}`;
        if (mode !== "explore") {
          const limit = mode === "boundary64" ? 65536 : 131072;
          const plainUnit = shape === "words" ? "alpha beta gamma " : shape === "combining" ? "e\u0301 alpha " : "x";
          const plain = plainUnit.repeat(Math.ceil((limit - 1) / plainUnit.length)).slice(0, limit - 1);
          const html = `<p>${"alpha ".repeat(Math.ceil(limit / 12)).slice(0, limit / 2 - 7)}</p>`;
          raw = shape === "html" ? `Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${plain.slice(0, limit / 2)}\r\n--b\r\nContent-Type: text/html\r\n\r\n${html}\r\n--b--\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${plain}`;
        }
        for (let sample = 0; sample < 3; sample++) {
          const start = performance.now();
          const parsed = await worker.run({ kind: "mime", chunks: [new TextEncoder().encode(raw)] }, new AbortController().signal);
          const workerWall = performance.now() - start;
          if (mode !== "explore" && (parsed.message.text?.length ?? 0) + (parsed.message.html?.length ?? 0) !== (mode === "boundary64" ? 65536 : 131072)) throw new Error("Incorrect boundary fixture");
          const cloneStart = performance.now(); const copy = structuredClone(parsed.message); const cloneWall = performance.now() - cloneStart;
          const before = performance.now();
          const result = await store.sync.ingest([msg({ accountId: account.id, bodyText: copy.text, bodyHtml: copy.html })], { applyFilters: true, now: 1, classifier: null });
          const storeWall = performance.now() - before;
          if (result.opIds.length || copy.text !== parsed.message.text || copy.html !== parsed.message.html) throw new Error("Policy measurement exactness failed");
          records.push({ shape, kib: mode === "boundary64" ? 64 : kib, sample, combined: (copy.text?.length ?? 0) + (copy.html?.length ?? 0), workerWall, cloneWall, storeWall });
        }
      }
      return records;
    } finally {
      await worker.close(); await store.close();
      await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName(name)); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
}
