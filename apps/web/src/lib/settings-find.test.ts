import { describe, expect, it } from "vitest";
import { excerpt, FIND_LIMIT, findSettings, fold, queryWords, type FindEntry } from "./settings-find";

const entry = (key: string, over: Partial<FindEntry<null>> = {}): FindEntry<null> => ({
  key,
  name: key,
  place: [{ text: "General", weight: 2 }],
  words: [],
  hint: null,
  data: null,
  ...over,
});

describe("fold", () => {
  it("lower-cases and drops accents, mapping back to the original text", () => {
    const f = fold("Notificación");
    expect(f.folded).toBe("notificacion");
    expect(f.from).toHaveLength("notificacion".length + 1);
  });
  it("maps a character of two code units back to its start", () => {
    const f = fold("😀x");
    expect(f.folded).toBe("😀x");
    expect(f.from).toEqual([0, 0, 2, 3]);
  });
  it("splits a query into folded words", () => {
    expect(queryWords("  Dárk  mode! ")).toEqual(["dark", "mode"]);
  });
});

describe("findSettings", () => {
  it("finds nothing for an empty query", () => {
    expect(findSettings([entry("Mode")], "  ")).toEqual([]);
  });

  it("needs every word to match somewhere", () => {
    const entries = [entry("Undo send", { place: [{ text: "General", weight: 2 }, { text: "Writing", weight: 2 }] }), entry("Send sound")];
    expect(findSettings(entries, "undo writing").map((f) => f.entry.key)).toEqual(["Undo send"]);
    expect(findSettings(entries, "undo reading")).toEqual([]);
  });

  it("matches a word's start, and inside a word from three letters", () => {
    const entries = [entry("Resync mail")];
    expect(findSettings(entries, "res")).toHaveLength(1);
    expect(findSettings(entries, "sync")).toHaveLength(1);
    expect(findSettings(entries, "yn")).toHaveLength(0);
  });

  it("matches without accents either way, and emphasizes the original text", () => {
    const [found] = findSettings([entry("Notificaciones del sistema")], "notificacion");
    expect(found!.name).toEqual([[0, 12]]);
    expect(findSettings([entry("Notifications")], "notificátions")).toHaveLength(1);
  });

  it("ranks the name over a description, and keeps Settings' order on ties", () => {
    const entries = [entry("Language", { hint: "The theme of menus" }), entry("Theme"), entry("Dark theme")];
    expect(findSettings(entries, "theme").map((f) => f.entry.key)).toEqual(["Theme", "Dark theme", "Language"]);
  });

  it("says nothing more when the name or the place shows why", () => {
    const [byName] = findSettings([entry("Undo send", { hint: "Take a message back" })], "undo");
    expect(byName!.reason).toBeNull();
    const [byPlace] = findSettings([entry("Signature", { place: [{ text: "Accounts", weight: 2 }, { text: "Work", weight: 3 }] })], "work");
    expect(byPlace!.reason).toBeNull();
    expect(byPlace!.place).toEqual([[], [[0, 4]]]);
  });

  it("names the related word that matched", () => {
    const [found] = findSettings([entry("Mode", { words: ["dark mode", "night"] })], "night");
    expect(found!.reason).toEqual({ kind: "word", word: "night" });
  });

  it("shows the description's words around the match", () => {
    const hint = "Blocked by default to prevent tracking; you can load them in each message, one at a time, whenever you like it.";
    const [found] = findSettings([entry("Remote images", { hint })], "tracking");
    const reason = found!.reason;
    expect(reason?.kind).toBe("hint");
    if (reason?.kind !== "hint") return;
    expect(reason.text.length).toBeLessThan(hint.length);
    expect(reason.text.endsWith("…")).toBe(true);
    const [[a, b]] = reason.ranges as [[number, number]];
    expect(reason.text.slice(a, b)).toBe("tracking");
  });

  it("prefers the description to a related word when both matched", () => {
    const [found] = findSettings([entry("Mode", { words: ["dark"], hint: "Follows your computer" })], "dark computer");
    expect(found!.reason?.kind).toBe("hint");
  });

  it("finds at most the limit", () => {
    const many = Array.from({ length: FIND_LIMIT + 10 }, (_, i) => entry(`Color ${i}`));
    expect(findSettings(many, "color")).toHaveLength(FIND_LIMIT);
  });
});

describe("excerpt", () => {
  it("keeps a short description whole", () => {
    expect(excerpt("Short.", [[0, 5]])).toEqual({ text: "Short.", ranges: [[0, 5]] });
  });
  it("cuts at word boundaries with ellipses on both sides", () => {
    const text = `${"lead ".repeat(12)}needle ${"tail ".repeat(20)}`.trim();
    const at = text.indexOf("needle");
    const { text: out, ranges } = excerpt(text, [[at, at + 6]]);
    expect(out.startsWith("…lead")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(ranges[0]![0], ranges[0]![1])).toBe("needle");
  });
});
