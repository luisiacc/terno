import { describe, expect, it } from "vitest";
import { readOfferAnswers, readSettings, stampSmartCategorize, updateSettings, type SettingsStore } from "./settings";

function memory(initial?: unknown): SettingsStore & { raw(): unknown; writes: number } {
  const values = new Map<string, unknown>(initial === undefined ? [] : [["app", initial]]);
  const store = {
    writes: 0,
    raw: () => values.get("app"),
    settings: {
      get: async <T,>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback),
      set: async (key: string, value: unknown) => void values.set(key, value),
      update: async <T, R>(key: string, fallback: T, f: (current: T) => { value: T; result: R }) => {
        const { value, result } = f((values.has(key) ? values.get(key) : fallback) as T);
        values.set(key, value);
        store.writes++;
        return result;
      },
    },
    secrets: { has: async () => false, get: async () => null, set: async () => {}, delete: async () => {} },
  };
  return store as never;
}

describe("the one-time reset of the AI switch", () => {
  it("turns off a switch that was on, and says so", async () => {
    const store = memory({ aiCategorize: true, appearanceVersion: 99, localMailVersion: 1 });
    await stampSmartCategorize(store);
    expect(store.raw()).toMatchObject({ aiCategorize: false, aiCategorizeWidened: true, smartCategorizeVersion: 1 });
  });

  it("writes only its stamp: read-time migrations stay unwritten until the user changes something", async () => {
    // an old profile with a design its version says to drop on the next real write
    const old = { design: "lumen", lightTheme: "x", aiCategorize: false };
    const store = memory(old);
    await stampSmartCategorize(store);
    expect(store.raw()).toEqual({ ...old, smartCategorizeVersion: 1 });
  });

  it("leaves a new install's empty row empty, so it's still told apart from an old profile", async () => {
    const store = memory();
    await stampSmartCategorize(store);
    expect(store.raw()).toBeUndefined();
    expect(store.writes).toBe(0);
  });

  it("runs once", async () => {
    const store = memory({ aiCategorize: true, appearanceVersion: 99 });
    await stampSmartCategorize(store);
    await updateSettings(store, { aiCategorize: true });
    await stampSmartCategorize(store);
    expect((await readSettings(store)).aiCategorize).toBe(true);
  });

  it("a switch the user turns on between its read and its write stays on", async () => {
    const store = memory({ aiCategorize: false, appearanceVersion: 99 });
    const read = store.settings.get.bind(store.settings);
    let raced = false;
    store.settings.get = (async (key: string, fallback: unknown) => {
      const value = await read(key, fallback);
      if (key === "app" && !raced) {
        raced = true;
        await updateSettings(store, { aiCategorize: true });
      }
      return value;
    }) as never;
    await stampSmartCategorize(store);
    expect((await readSettings(store)).aiCategorize).toBe(true);
  });

  it("a switch turned on after a fresh install stays on across a restart", async () => {
    const store = memory();
    await stampSmartCategorize(store);
    await updateSettings(store, { aiCategorize: true });
    await stampSmartCategorize(store);
    expect((await readSettings(store)).aiCategorize).toBe(true);
  });
});

describe("plan 211: What matters and Follow-ups with no offers", () => {
  it("on by default, a stored off stays off, and the offers' answers are read from the row as written but never shown", async () => {
    expect((await readSettings(memory())).dated).toEqual({ enabled: true, enabledAt: null });
    expect((await readSettings(memory())).followups).toMatchObject({ enabled: true, enabledAt: null });
    const off = memory({ dated: { enabled: false, enabledAt: null, scanAnswered: false, offerDismissed: true }, followups: { enabled: false, enabledAt: null, nudgeAfterDays: 5, scanAnswered: true } });
    const read = await readSettings(off);
    expect(read.dated).toEqual({ enabled: false, enabledAt: null });
    expect(read.followups).toEqual({ enabled: false, enabledAt: null, nudgeAfterDays: 5 });
    expect(await readOfferAnswers(off)).toEqual({ dated: false, followups: true });
    // a write of the user's drops them for good, and turning it on records the moment
    await updateSettings(off, { dated: { enabled: true } }, 77);
    expect((off.raw() as { dated: unknown }).dated).toEqual({ enabled: true, enabledAt: 77 });
  });
});
