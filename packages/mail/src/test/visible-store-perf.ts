import { expect, it } from "vitest";
import type { MailStore } from "@terno/store";
import { ingest, msg, withAccounts } from "../../../store/src/conformance/fixtures";
import { watchLoop } from "../../../db/src/test/timing";
import { bundledParser } from "./bundled-parser";

const fixtures = [
  ["ordinary", '<p>Useful visiblephrase</p><div hidden>phantomneedle</div>'],
  ["depth64", '<div>'.repeat(64) + '<p>Useful visiblephrase</p><span hidden>phantomneedle</span>' + '</div>'.repeat(64)],
  ["width128", '<p>Useful visiblephrase</p>' + '<p>ordinary content</p><div hidden>phantomneedle</div>'.repeat(128)],
  ["styles64", '<p>Useful visiblephrase</p>' + '<div style="display:none!important;display:block;background:url(https://invalid.test/x)">phantomneedle</div>'.repeat(64)],
  ["token8KiB", '<p>Useful visiblephrase</p><span>' + 'x'.repeat(8192) + '</span><p hidden>phantomneedle</p>'],
] as const;

export function defineVisibleStorePerf(name: string, open: () => Promise<MailStore>): void {
  it(`${name}: complete HTML MIME -> durable action/search stays within 15 ms slices for bounded ordinary/deep/wide/style/token fixtures`, async () => {
    const parser = await bundledParser();
    const store = await open();
    try {
      const [accountId] = await withAccounts(store, 1);
      await store.filters.save({ name: "visible body", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "visiblephrase" }], actions: [{ type: "archive" }] } }, 0);
      for (const [label, html] of fixtures) {
        const source = `From: sender@example.test\r\nSubject: ${label}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
        const monitor = watchLoop(15);
        let timing;
        try {
          const parsed = await parser.parseRaw(source);
          const result = await ingest(store, [msg({ accountId: accountId!, providerMsgId: label, from: parsed.from, subject: parsed.subject, bodyText: parsed.text, bodyHtml: parsed.html })]);
          expect(result.opIds).toHaveLength(1);
          expect((await store.threads.searchText({ query: "phantomneedle", now: 0, limit: 10 })).items).toEqual([]);
          const found = (await store.threads.searchText({ query: `subject:${label} visiblephrase`, now: 0, limit: 10 })).items;
          expect(found).toHaveLength(1);
          expect((await store.threads.get(found[0]!.id))!.thread.inInbox).toBe(false);
        } finally { timing = monitor.stop(); }
        process.stderr.write(`[visible ${name} ${label}] ${source.length} raw chars, ${timing.ms.toFixed(2)} ms elapsed, ${timing.stall.toFixed(2)} ms max stall\n`);
        expect(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(15);
      }
    } finally { await store.close(); parser.close(); }
  });
}
