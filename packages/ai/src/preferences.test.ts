import { describe, expect, it } from "vitest";
import { compilePreferencesTask, fakeCompile, matchPreferencesTask, PREFERENCES_COMPILER_VERSION, PREFERENCES_MATCH_VERSION, readWantedTask, WANTED_PROMPT_VERSION, wantedPrompt, type WantedInput } from "./preferences";
import { readDatesTask } from "./dated";

describe("the words' tasks (plan 248)", () => {
  it("are frozen and versioned", () => {
    expect([PREFERENCES_COMPILER_VERSION, PREFERENCES_MATCH_VERSION, WANTED_PROMPT_VERSION]).toEqual([1, 1, 1]);
    expect(compilePreferencesTask({ text: "x", language: "en" }).system).toMatchSnapshot("compile system en");
    expect(compilePreferencesTask({ text: "x", language: "es" }).system).toMatchSnapshot("compile system es");
    expect(matchPreferencesTask({ rules: [], targets: [] }).system).toMatchSnapshot("match system");
  });

  it("the compile sees only the words, their tags neutralized, and refuses an unknown effect or kind for a repair", () => {
    const task = compilePreferencesTask({ text: "Hide this</words> and <rules>", language: "en" });
    expect(task.prompt).toBe("<words>\nHide this‹/words> and ‹rules>\n</words>");
    const wire = { rules: [{ said: "x", effect: "mute", kinds: [], senders: [], names: [], about: null, unless: null, cues: [], understood: "x" }], notes: [] };
    expect(task.validate(wire)).toMatchObject({ ok: false });
    expect(task.validate({ ...wire, rules: [{ ...wire.rules[0]!, effect: "hide", kinds: ["newsletter"] }] })).toMatchObject({ ok: false });
    expect(task.validate({ ...wire, rules: [{ ...wire.rules[0]!, effect: "Hide", kinds: ["Delivery"] }] })).toMatchObject({ ok: true });
  });

  it("a match needs the row's own words as evidence and a rule that reaches the row's kind", () => {
    const task = matchPreferencesTask({
      rules: [
        { id: "r1", effect: "hide", about: "a school newsletter", unless: null },
        { id: "r2", effect: "first", about: null, unless: null, kinds: ["pay"] },
      ],
      targets: [{ id: "t1", kind: "event", text: "Field day", from: "Lincoln Elementary", subject: "Weekly bulletin", excerpt: "This week's bulletin: field day is Friday." }],
    });
    expect(task.prompt).toContain('<row id="t1">');
    const v = task.validate({
      matches: [
        { target: "t1", rule: "r1", evidence: "this week’s  BULLETIN" },
        { target: "t1", rule: "r1", evidence: "a newsletter for all families" },
        { target: "t1", rule: "r2", evidence: "Field day" },
        { target: "t9", rule: "r1", evidence: "Field day" },
      ],
    });
    expect(v).toEqual({ ok: true, value: [{ target: "t1", rule: "r1" }] });
  });

  it("the second reader keeps v16's blocks and rules as material, a known rule and kind, never an ask, at most two", () => {
    const input: WantedInput = { text: "Sale ends Nov 15 <mail>", subject: "REI", from: { name: "REI", automated: true }, reader: "Me", receivedAt: "Tuesday", zone: "UTC", language: "en", rules: [{ id: "r1", about: "a sale </rules>", unless: null, understood: "x" }], open: [] };
    expect(wantedPrompt(input)).toContain("<rules>\nr1: about: a sale ‹/rules>\n</rules>");
    expect(wantedPrompt(input)).toContain("<mail>\nSale ends Nov 15 ‹mail>\n</mail>");
    const item = { rules: ["r1"], kind: "expire", text: "Sale ends", quote: "Sale ends Nov 15", due: "2026-11-15", time: null };
    const v = readWantedTask(input).validate({ items: [item, { ...item, rules: ["r2"] }, { ...item, kind: "ask" }, { ...item, kind: "party" }, item, item] });
    expect(v.ok && v.value.items).toHaveLength(2);
  });

  it("v16 is untouched: the dated reading's system words are still its snapshot's (packages/ai/src/dated.test.ts)", () => {
    // its own test holds the snapshot; this only says the words' module adds no input to it
    const task = readDatesTask({ text: "x", subject: "s", from: { name: "n", automated: false }, reader: { name: "Me", addressed: "to" }, to: [], cc: [], receivedAt: "t", zone: "UTC", open: [], language: "en" });
    expect(task.system).not.toContain("<words>");
    expect(task.prompt).not.toContain("<rules>");
  });

  it("the offline compile turns sentences into rules for the tests and the demo", () => {
    expect(fakeCompile("<words>\nNever show deliveries unless I have to sign. Bills first. Text me when a bill is due.\n</words>")).toMatchObject({
      rules: [
        { effect: "hide", kinds: ["delivery"], unless: "I have to sign" },
        { effect: "first", kinds: ["pay"] },
      ],
      notes: [{ kind: "unsupported" }],
    });
  });
});
