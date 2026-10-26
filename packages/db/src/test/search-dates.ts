import { parseSearch } from "@terno/core";
import type { SearchPage } from "@terno/core/rpc";
import { StaleCursorError, type IncomingMessage, type MailStore, type SearchCursor, type StoreSearchPage } from "@terno/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export const DATE_ZONES = ["UTC", "America/Costa_Rica", "Asia/Kathmandu", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "America/Sao_Paulo", "Pacific/Apia", "Atlantic/Azores"] as const;
type DateZone = typeof DATE_ZONES[number];
type Day = readonly [date: string, nextDate: string, start: string, end: string];

// UTC instants are independent worked examples, not computed by the parser under test.
const DAYS: Record<DateZone, readonly Day[]> = {
  UTC: [["2026-03-08", "2026-03-09", "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z"]],
  "America/Costa_Rica": [["2026-03-08", "2026-03-09", "2026-03-08T06:00:00Z", "2026-03-09T06:00:00Z"]],
  "Asia/Kathmandu": [["2026-03-08", "2026-03-09", "2026-03-07T18:15:00Z", "2026-03-08T18:15:00Z"]],
  "America/New_York": [
    ["2026-03-08", "2026-03-09", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-02", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ],
  "Europe/Berlin": [
    ["2026-03-29", "2026-03-30", "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z"],
    ["2026-10-25", "2026-10-26", "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"],
  ],
  "Australia/Lord_Howe": [
    ["2026-04-05", "2026-04-06", "2026-04-04T13:00:00Z", "2026-04-05T13:30:00Z"],
    ["2026-10-04", "2026-10-05", "2026-10-03T13:30:00Z", "2026-10-04T13:00:00Z"],
  ],
  "America/Sao_Paulo": [
    ["2018-11-04", "2018-11-05", "2018-11-04T03:00:00Z", "2018-11-05T02:00:00Z"],
    ["0099-10-03", "0099-10-04", "0099-10-03T03:06:28Z", "0099-10-04T03:06:28Z"],
  ],
  "Pacific/Apia": [["2011-12-29", "2011-12-31", "2011-12-29T10:00:00Z", "2011-12-30T10:00:00Z"]],
  "Atlantic/Azores": [["1916-06-17", "1916-06-18", "1916-06-17T02:00:00Z", "1916-06-18T01:00:00Z"]],
};

export interface DateSearchHarness {
  store: MailStore;
  search(query: string, cursor?: SearchCursor, limit?: number): Promise<StoreSearchPage | SearchPage>;
  ready(): Promise<void>;
  close(): Promise<void>;
  instant: boolean;
  fallback: "sql" | "scan";
  rpc?: boolean;
}

function message(accountId: number, label: string, date: number, serial: number, bodyText = "needle"): IncomingMessage {
  return {
    accountId, providerMsgId: `date-${serial}`, providerThreadId: label,
    rfcMessageId: `date-${serial}@example.test`, inReplyTo: null, references: [],
    from: { name: "Sender", email: "sender@example.test" }, to: [{ name: "Reader", email: "reader@example.test" }], cc: [], bcc: [],
    subject: label, date, snippet: "", bodyText, bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 20,
  };
}

export function defineDateSearch(name: string, open: (now: number) => Promise<DateSearchHarness>): void {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace("Katmandu", "Kathmandu") as DateZone;
  describe.skipIf(!DAYS[zone])(`${name}: local date queries (${zone})`, () => {
    for (const [date, nextDate, startUtc, endUtc] of DAYS[zone] ?? DAYS.UTC) {
      describe(date, () => {
        const start = Date.parse(startUtc);
        const end = Date.parse(endUtc);
        const range = `after:${date} before:${nextDate}`;
        const expected = ["mixed", "last", "dedup", "start-tie", "at-start"];
        let h: DateSearchHarness;
        beforeEach(async () => {
          h = await open(end);
          const { account } = await h.store.accounts.create({ kind: "gmail", email: "reader@example.test", displayName: "Reader", color: "indigo", now: end });
          const rows: [string, number, string?][] = [
            ["before-start", start - 1], ["at-start", start], ["start-tie", start], ["last", end - 1],
            ["at-end", end], ["after-end", end + 1],
            ["split", start - 1], ["split", end],
            ["mixed", start + 1], ["mixed", end + 2, "outsideonly"],
            ["dedup", start + 2], ["dedup", start + 3],
          ];
          const ingested = await h.store.sync.ingest(rows.map(([label, at, body], i) => message(account.id, label, at, i, body)), { now: end, applyFilters: false, classifier: null });
          expect(ingested.inserted).toHaveLength(12);
          expect((await h.store.threads.list({ view: "all", limit: 100 })).items).toHaveLength(9);
          if (h.rpc) {
            const { account: other } = await h.store.accounts.create({ kind: "gmail", email: "other@example.test", displayName: "Other", color: "indigo", now: end });
            await h.store.sync.ingest([message(other.id, "another-account", start + 10, 888)], { now: end, applyFilters: false, classifier: null });
          }
          await h.ready();
        });
        afterEach(async () => h?.close());
        const subjects = async (query: string, sqlStrategy?: string) => {
          const p = await h.search(query);
          expect(p.complete).toBe(true);
          if (h.instant) expect(p.strategy).toMatch(/^instant:/);
          else if (h.fallback === "scan") expect(p.strategy).toBe("scan");
          else if (sqlStrategy) expect(p.strategy).toBe(sqlStrategy);
          return p.items.map((t) => t.subject);
        };

        it("parses local midnight to the specified exact epoch bounds", () => {
          expect.soft(parseSearch(range, end)).toMatchObject({ after: start, before: end, terms: [] });
          expect.soft(parseSearch(`before:${date} after:${date}`, end)).toMatchObject({ after: start, before: start, terms: [] });
          expect.soft(parseSearch(`-after:${date} -before:${date}`, end)).toMatchObject({ after: start, before: start, terms: [] });
          expect.soft(parseSearch(`después:${date.replaceAll("-", "/")} antes:${nextDate}`, end)).toMatchObject({ after: start, before: end, terms: [] });
          expect(parseSearch(`on:${date}`, end).terms[0]?.value).toBe(`on:${date}`);
          if (zone === "Pacific/Apia") {
            for (const operator of ["before", "after"] as const) {
              const skipped = parseSearch(`${operator}:2011-12-30`, end);
              expect(skipped[operator]).toBeUndefined();
              expect(skipped.terms).toEqual([{ field: "text", value: `${operator}:2011-12-30`, phrase: false, negate: false, prefix: true }]);
            }
          }
        });

        it("searches invalid calendar operators as literal text instead of a rolled-over cutoff", async () => {
          const account = (await h.store.accounts.list()).find((a) => a.email === "reader@example.test")!;
          await h.store.sync.ingest([message(account.id, "invalid-literal", end + 3, 999, "before:2026-02-30")], { now: end, applyFilters: false, classifier: null });
          await h.ready();
          expect(await subjects('before:"2026-02-30"')).toEqual(["invalid-literal"]);
          expect(await subjects('-before:"2026-02-30"')).toEqual(["mixed", "after-end", "split", "at-end", "last", "dedup", "start-tie", "at-start", "before-start"]);
        });

        it("includes the start millisecond, excludes the end, and orders/deduplicates matching conversations", async () => {
          expect.soft(await subjects(range, "walk")).toEqual(expected);
          expect.soft(await subjects(`-before:${date} -after:${nextDate}`)).toEqual(expected);
          expect.soft(await subjects(`before:${date}`, "date-index")).toEqual(["split", "before-start"]);
          expect.soft(await subjects(`-after:${date}`)).toEqual(["split", "before-start"]);
          expect.soft(await subjects(`after:${date}`)).toEqual(["mixed", "after-end", "split", "at-end", "last", "dedup", "start-tie", "at-start"]);
          expect.soft(await subjects(`after:${nextDate}`)).toEqual(["mixed", "after-end", "split", "at-end"]);
        });

        it("applies both dates and text to the same message, even when the thread's newest message is outside the day", async () => {
          expect(await subjects(`needle ${range}`, "fts")).toEqual(expected);
          expect(await subjects(`outsideonly ${range}`)).toEqual([]);
          expect(await subjects(`from:sender@example.test ${range}`, "sender-index")).toEqual(expected);
        });

        it("pages ties without gaps or duplicates and refuses a cursor for another date range", async () => {
          const seen: string[] = [];
          let cursor: SearchCursor | undefined;
          let first: SearchCursor | undefined;
          do {
            const p = await h.search(range, cursor, 1);
            seen.push(...p.items.map((t) => t.subject));
            cursor = p.nextCursor ?? undefined;
            first ??= cursor;
          } while (cursor && seen.length <= 12);
          expect(cursor).toBeUndefined();
          expect(seen).toEqual(expected);
          expect(first).toBeDefined();
          const different = h.search(`after:${nextDate}`, first, 1);
          if (h.rpc) await expect(different).rejects.toMatchObject({ code: "STALE", details: { reason: "query" } });
          else await expect(different).rejects.toBeInstanceOf(StaleCursorError);
        });

        it("keeps relative days as elapsed 24-hour durations across clock changes", async () => {
          expect(parseSearch("after:1d", end).after).toBe(end - 86_400_000);
          const newest = ["mixed", "after-end", "split", "at-end", "last"];
          const atMidnight = [...newest, "dedup", "start-tie", "at-start"];
          const relative = end - start > 86_400_000 ? newest : end - start === 86_400_000 ? atMidnight : [...atMidnight, "before-start"];
          expect(await subjects("after:1d")).toEqual(relative);
        });
      });
    }
  });
}
