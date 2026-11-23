import { describe, expect, it } from "vitest";
import { needsYou, type WaitingRow } from "./today";

const row = (id: number, from: string, o: Partial<WaitingRow> = {}): WaitingRow => ({ id, lastDate: 1000 - id, waitingSince: 1000 - id, from, subject: `S${id}`, hasSent: false, ...o });

describe("needsYou", () => {
  it("plan 240: every waiting conversation of a sender always shown, never a calendar's answer; the single-conversation rule stays for the rest", () => {
    const rows = [row(1, "News@Shop.com"), row(2, "news+x@shop.com"), row(3, "ana@friends.com"), row(4, "ana@friends.com"), row(5, "bo@friends.com"), row(6, "news@shop.com", { subject: "Accepted: Lunch" })];
    const known = (key: string) => (key.endsWith("@friends.com") ? { written: 1, own: 0 } : undefined);
    // Ana has two unanswered: neither (plan 145); Bo one: in; the shop never written to: out
    expect(needsYou(rows, known).map((r) => r.id)).toEqual([5]);
    expect(needsYou(rows, known, (key) => key === "news@shop.com").map((r) => r.id)).toEqual([1, 2, 5]);
  });
});
