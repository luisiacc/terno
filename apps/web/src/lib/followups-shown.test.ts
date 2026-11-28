import { afterEach, describe, expect, it, vi } from "vitest";

// node: a Map-backed localStorage, refusing on demand
const store = vi.hoisted(() => {
  const map = new Map<string, string>();
  const s = { refuse: false, map };
  (globalThis as Record<string, unknown>).localStorage = {
    setItem: (k: string, v: string) => {
      if (s.refuse) throw new Error("refused");
      map.set(k, v);
    },
    getItem: (k: string) => {
      if (s.refuse) throw new Error("refused");
      return map.get(k) ?? null;
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return s;
});

const load = async () => {
  vi.resetModules();
  return import("./followups-shown");
};

afterEach(() => {
  store.refuse = false;
  store.map.clear();
});

describe("follow-ups shown in the reader (plan 296)", () => {
  it("shown by default; hidden is written and read back on the next launch", async () => {
    const first = await load();
    expect(first.useFollowupsShown.getState().shown).toBe(true);
    first.setFollowupsShown(false);
    expect(first.useFollowupsShown.getState().shown).toBe(false);
    expect(store.map.get("terno:followupsShown")).toBe("hidden");
    const next = await load();
    expect(next.useFollowupsShown.getState().shown).toBe(false);
    next.setFollowupsShown(true);
    expect((await load()).useFollowupsShown.getState().shown).toBe(true);
  });

  it("another window's choice is followed (a web tab taking over keeps its page)", async () => {
    const m = await load();
    const listeners: ((e: { key: string }) => void)[] = [];
    vi.stubGlobal("addEventListener", (type: string, fn: (e: { key: string }) => void) => type === "storage" && listeners.push(fn));
    const live = await load();
    store.map.set("terno:followupsShown", "hidden");
    for (const fn of listeners) fn({ key: "terno:followupsShown" });
    expect(live.useFollowupsShown.getState().shown).toBe(false);
    for (const fn of listeners) fn({ key: "terno:other" });
    expect(live.useFollowupsShown.getState().shown).toBe(false);
    expect(m.useFollowupsShown.getState().shown).toBe(true);
    vi.unstubAllGlobals();
  });

  it("storage refused: shown, and a choice holds for the session", async () => {
    store.refuse = true;
    const m = await load();
    expect(m.useFollowupsShown.getState().shown).toBe(true);
    m.setFollowupsShown(false);
    expect(m.useFollowupsShown.getState().shown).toBe(false);
  });
});
