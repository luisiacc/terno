/** Plan 281 (owner, 2026-11-26): People's order follows What matters' word on what isn't open yet (`TodayWhy.ahead`). */
import { describe, expect, it } from "vitest";
import { personItemId, personSince, sortPeopleOpen, sortPersonItems, type PersonItem, type PersonOpen } from "./people-view";
import type { ThreadSummary } from "./types";

const NOW = new Date(2026, 10, 26, 19).getTime();
const DAY = 86_400_000;
const thread = { id: 1, lastDate: NOW - 20 * DAY } as ThreadSummary;
/** a dated item: came then, behind Coming up until `ahead` (its deadline after) when given */
const dated = (id: number, came: number, ahead?: number, due?: number): PersonItem => ({ kind: "today", item: { id: `dated:${id}`, thread, why: { kind: "dated", came, dueAt: due, ...(ahead !== undefined && { ahead }) } } });
const person = (key: string, items: PersonItem[]): PersonOpen => {
  const sorted = sortPersonItems(items, NOW);
  return { key, email: key, name: key, items: sorted, since: personSince(sorted, NOW) };
};

describe("People's order", () => {
  // two renewals whose deadlines and times to act sort in opposite orders: the one due later comes to act on first
  const soonDue = dated(1, NOW - 15 * DAY, NOW + 20 * DAY, NOW + 21 * DAY);
  const laterDue = dated(2, NOW - 14 * DAY, NOW + 10 * DAY, NOW + 40 * DAY);
  const reply = dated(3, NOW - 2 * DAY);

  it("a person's items: what's open now first, however long the rest has been there; then what isn't open yet, by when it is", () => {
    const p = person("ana", [soonDue, laterDue, reply]);
    expect(p.items.map(personItemId)).toEqual(["dated:3", "dated:2", "dated:1"]);
    expect(p.since).toBe(NOW - 2 * DAY);
  });

  it("Open: who has something open now first; those with nothing open yet last, by when theirs is, never counted", () => {
    const people = sortPeopleOpen([person("gonzalo", [soonDue]), person("bea", [reply]), person("carl", [laterDue])], NOW);
    expect(people.map((p) => [p.key, p.since])).toEqual([
      ["bea", NOW - 2 * DAY],
      ["carl", null],
      ["gonzalo", null],
    ]);
  });
});
