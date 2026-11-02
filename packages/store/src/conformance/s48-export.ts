import { expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { msg, withAccounts } from "./fixtures";

export function exactBodyExport(open: () => Promise<MailStore>): void {
  it("exports complete captured text and HTML in bounded random-access stretches", async () => {
    const store = await open();
    try {
      const [accountId] = await withAccounts(store, 1);
      const text = "x".repeat(32767) + "😀\r\n" + "tail 🧡 e\u0301 ".repeat(6000), html = "<p>" + text + "</p>";
      const r = await store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyHtml: html })], { now: 1, applyFilters: false, classifier: null });
      const id = r.inserted[0]!, metadata = await store.folderExport.messages([id]);
      expect(metadata.map((m) => [m.hasText, m.hasHtml, m.bodyState])).toEqual([[true, true, "full"]]);
      for (const [field, expected] of [["text", text], ["html", html]] as const) {
        const chunks: string[] = [];
        for (let at: number | null = 0; at !== null;) {
          const chunk = await store.folderExport.body(id, field, at, 32768, "exact");
          expect(chunk).not.toBeNull();
          expect(chunk!.text.length).toBeLessThanOrEqual(32768);
          if (chunk!.next !== null) expect(chunk!.text.charCodeAt(chunk!.text.length - 1) & 0xfc00).not.toBe(0xd800);
          chunks.push(chunk!.text); at = chunk!.next;
        }
        expect(chunks.join("") === expected).toBe(true);
        const tail = await store.folderExport.body(id, field, 65536, 100, "exact");
        expect(tail!.text === expected.slice(65536, 65636)).toBe(true);
      }
      store.folderExport.release("exact");
    } finally { await store.close(); }
  });
}
