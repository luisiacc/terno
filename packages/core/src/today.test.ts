import { describe, expect, it } from "vitest";
import { aiFeaturesAvailable, nextPrepareAt, prepareTimeToday, todayKey } from "./today";

const settings = (provider: string, over = {}) => ({ ai: { provider, model: "m", needsKey: false, hasKey: false, keyConfirmed: false, keyUnreadable: false, keys: {}, ...over } }) as never;

describe("who sees Today (plan 145)", () => {
  it("a provider set up, or the entitlement Pro will bring; nothing without either", () => {
    expect(aiFeaturesAvailable(settings("none"))).toBe(false);
    expect(aiFeaturesAvailable(settings("ollama"))).toBe(true);
    expect(aiFeaturesAvailable(settings("none"), { active: true })).toBe(true);
    expect(aiFeaturesAvailable(settings("none"), { active: false })).toBe(false);
    expect(aiFeaturesAvailable(null)).toBe(false);
  });

  it("a provider that needs a key, without one, is none", () => {
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true, hasKey: true, keyConfirmed: true }))).toBe(true);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "groq", needsKey: true, hasKey: true, keyConfirmed: true, keyUnreadable: true }))).toBe(false);
  });

  it("plan 168: the one rule, so Today never shows where the digest can't run (Codex code review)", () => {
    expect(aiFeaturesAvailable(settings("ollama", { model: "" }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "custom", baseURL: null }))).toBe(false);
    expect(aiFeaturesAvailable(settings("compatible", { preset: "custom", baseURL: "http://127.0.0.1:8080/v1" }))).toBe(true);
  });

  it("plan 168: on Claude or OpenAI, a usable key for either, whichever of the two is stored", () => {
    const key = (over = {}) => ({ hasKey: true, keyHint: null, ...over });
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: {} }))).toBe(false);
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: { openai: key() } }))).toBe(true);
    expect(aiFeaturesAvailable(settings("openai", { needsKey: true, keyUnreadable: true, keys: { openai: key({ keyUnreadable: true }), anthropic: key() } }))).toBe(true);
    expect(aiFeaturesAvailable(settings("anthropic", { needsKey: true, keys: { anthropic: key({ keyConfirmed: false }) } }))).toBe(false);
  });
});

describe("when it's prepared", () => {
  it("the next time round, today if it's still to come, tomorrow if it's gone", () => {
    const morning = new Date(2026, 10, 5, 7, 0).getTime();
    expect(nextPrepareAt("08:00", morning)).toBe(new Date(2026, 10, 5, 8, 0).getTime());
    const after = new Date(2026, 10, 5, 8, 0).getTime();
    expect(nextPrepareAt("08:00", after)).toBe(new Date(2026, 10, 6, 8, 0).getTime());
    expect(prepareTimeToday("08:30", morning)).toBe(new Date(2026, 10, 5, 8, 30).getTime());
    expect(todayKey(morning)).toBe("2026-11-05");
  });

  it("across a clock change, it's the same time on the wall", () => {
    // a year's worth of days: whichever the zone's changes are, each next is 8:00 local
    let at = new Date(2026, 0, 1, 9, 0).getTime();
    for (let i = 0; i < 366; i++) {
      at = nextPrepareAt("08:00", at);
      const d = new Date(at);
      expect([d.getHours(), d.getMinutes()]).toEqual([8, 0]);
    }
  });
});
