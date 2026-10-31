import { afterEach, describe, expect, it, vi } from "vitest";

// node: a Map-backed localStorage
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
});
import { boost, MAX, noteUse, readUsage, recentIds, recordUse, type Usage } from "./palette-usage";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => localStorage.clear());

describe("palette usage", () => {
  it("records runs and reads them back", () => {
    noteUse("thread.archive", 1000);
    noteUse("thread.archive", 2000);
    noteUse("go.inbox", 3000);
    expect(readUsage().get("thread.archive")).toEqual({ n: 2, at: 2000 });
    expect(readUsage().get("go.inbox")).toEqual({ n: 1, at: 3000 });
  });

  it("keeps the last MAX ids, dropping the least recently used", () => {
    let u: Usage = new Map();
    for (let i = 0; i <= MAX; i++) u = recordUse(u, `c${i}`, i);
    expect(u.size).toBe(MAX);
    expect(u.has("c0")).toBe(false);
    expect(u.has(`c${MAX}`)).toBe(true);
  });

  it("reads a corrupt or foreign store as empty", () => {
    localStorage.setItem("terno:palette-usage", "{not json");
    expect(readUsage().size).toBe(0);
    localStorage.setItem("terno:palette-usage", JSON.stringify({ a: 1 }));
    expect(readUsage().size).toBe(0);
    localStorage.setItem("terno:palette-usage", JSON.stringify([["ok", 1, 5], [3, 1, 5], ["bad", "x", 5]]));
    expect([...readUsage().keys()]).toEqual(["ok"]);
  });

  it("boosts with use, capped, and decays with time", () => {
    const now = 100 * DAY;
    expect(boost(undefined, now)).toBe(1);
    const once = boost({ n: 1, at: now }, now);
    const often = boost({ n: 1000, at: now }, now);
    expect(once).toBeGreaterThan(1);
    expect(often).toBe(1.5);
    expect(boost({ n: 1000, at: now - 14 * DAY }, now)).toBeCloseTo(1.25);
  });

  it("never lets a weak frequent match beat a strong one", () => {
    // command-score: a prefix match scores ~0.9+, a scattered one well under 0.3
    expect(0.3 * boost({ n: 10_000, at: 0 }, 0)).toBeLessThan(0.9);
  });

  it("lists recent ids among the available ones, newest first", () => {
    let u: Usage = new Map();
    u = recordUse(u, "a", 1);
    u = recordUse(u, "b", 2);
    u = recordUse(u, "gone", 3);
    u = recordUse(u, "c", 4);
    expect(recentIds(u, new Set(["a", "b", "c"]), 2)).toEqual(["c", "b"]);
  });
});
