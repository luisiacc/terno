// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { foundSummary } = await import("~/components/action-preview-header");

const NOW = new Date(2026, 9, 22, 16, 0).getTime();
const row = (fromName: string, day: number, accountId: number) => ({ fromName, fromEmail: `${fromName}@x.test`, lastDate: new Date(2026, 7, day, 9).getTime(), accountId });
const name = (id: number) => (id === 1 ? "Freelance" : id === 2 ? "Acme Studio" : "");

describe("plan 162 (after ai162-r01): what an action's search found, from its rows", () => {
  it("names the senders by how many, the dates' span and the accounts, with no model", () => {
    const found = foundSummary([row("Mercado Libre", 28, 1), row("Amazon México", 19, 1), row("Mercado Libre", 7, 2)], name, NOW)!;
    expect(found.from).toBe("Mercado Libre (2) and Amazon México");
    expect(found.dates).toBe("Aug 7 to Aug 28");
    expect(found.accounts).toBe("Freelance and Acme Studio");
  });
  it("folds senders past four into a count, says one day once, and leaves one account unsaid", () => {
    const found = foundSummary(["A", "B", "C", "D", "E", "F"].map((n) => row(n, 3, 1)), name, NOW)!;
    expect(found.from).toBe("A, B, C, D, and 2 more");
    expect(found.dates).toBe("Aug 3");
    expect(found.accounts).toBeNull();
    expect(foundSummary([], name, NOW)).toBeNull();
  });
  it("plan 162 (after ai162-r02): a span across years says both years, never one end's", () => {
    const old = { ...row("A", 11, 1), lastDate: new Date(2025, 4, 11, 9).getTime() };
    expect(foundSummary([old, row("B", 28, 1)], name, NOW)!.dates).toBe("May 11, 2025 to Aug 28, 2026");
  });
});
