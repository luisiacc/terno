/**
 * Plan 128: a filter moving new mail to a folder, at 50k threads and 250 folders. A slice of arrivals that all match it
 * stays inside the slicer's budget, and costs at most 2.5× a filter's archive: the same work plus its one op more and the membership overlay.
 * Plan 259: the same for an Outlook account whose 50k messages are each in one of the 250 folders (membership and the
 * overlay read `message_folders` beside labels and locations).
 */
import type { AccountKind, FilterAction } from "@terno/core";
import { msg } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { createAccount } from "./repos";
import { SqlMailStore } from "./sql-store";
import { testDb } from "./test/helpers";
import { BUDGET_MULTIPLIER } from "./test/perf";
import { populateRuleScope } from "./test/rule-scope";
import { threadCpuMs } from "./test/timing";

const SLICE = 200;
const ROUNDS = 6;
const NOW = Date.UTC(2026, 10, 3);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function filing(kind: AccountKind): Promise<void> {
  const db = testDb();
  const accountId = createAccount(db, { kind, email: "me@example.com", displayName: "Me", color: "brown" }).id;
  populateRuleScope(db, accountId);
  // plan 259: every message of the mailbox in a folder of its own, spread over the 250
  if (kind === "outlook") db.run("INSERT INTO message_folders (message_id, account_id, folder) SELECT id, account_id, 'F' || (id % 250) FROM messages");
  const store = new SqlMailStore(db);
  await store.folders.replace(accountId, Array.from({ length: 250 }, (_, i) => ({ key: `F${i}`, path: [`F${i}`], selectable: true })));
  const save = (email: string, action: FilterAction) => store.filters.save({ name: email, enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "from", op: "equals", value: email }], actions: [action] } }, NOW);
  await save("archive@perf.test", { type: "archive" });
  await save("folder@perf.test", { type: "moveToFolder", accountId, folder: "F125" });
  const costs = { archive: [] as number[], folder: [] as number[] };
  const run = async (side: "archive" | "folder", round: number) => {
    const where = kind === "outlook" ? { folder: null } : { gmailLabels: ["INBOX"] };
    const mail = Array.from({ length: SLICE }, (_, i) => msg({ accountId, providerMsgId: `${side}-${round}-${i}`, rfcMessageId: `${side}-${round}-${i}@perf.test`, from: { name: side, email: `${side}@perf.test` }, ...where, date: NOW + i }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const started = threadCpuMs();
    const r = await store.sync.ingest(mail, { applyFilters: true, now: NOW, classifier: null });
    if (round >= 0) costs[side].push(threadCpuMs() - started);
    expect(r.inserted.length).toBe(SLICE);
    expect(r.opIds.length).toBeGreaterThan(0);
    // the queue never builds up across rounds: both sides read it as they would at rest
    for (const id of r.opIds) await store.ops.complete(id, {}, NOW);
  };
  for (let round = -1; round < ROUNDS; round++) {
    for (const side of round % 2 ? (["archive", "folder"] as const) : (["folder", "archive"] as const)) await run(side, round);
  }
  const archive = median(costs.archive);
  const folder = median(costs.folder);
  console.log(`${kind}: folder ${folder.toFixed(1)} ms, archive ${archive.toFixed(1)} ms a slice of ${SLICE}`);
  expect(folder, `${kind}: folder ${folder.toFixed(1)} ms, archive ${archive.toFixed(1)} ms a slice of ${SLICE}`).toBeLessThanOrEqual(archive * 2.5 * BUDGET_MULTIPLIER);
  expect(folder, `${kind}: folder ${folder.toFixed(1)} ms a slice of ${SLICE}`).toBeLessThanOrEqual(120 * BUDGET_MULTIPLIER);
}

it("a slice of new mail all moved by a folder's filter stays within 2.5× an archive filter's", { timeout: 300_000 }, () => filing("gmail"));

it("plan 259: an Outlook account's, its 50k messages each in a folder, likewise", { timeout: 300_000 }, () => filing("outlook"));
