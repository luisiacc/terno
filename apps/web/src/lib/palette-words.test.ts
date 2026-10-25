import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { englishWords } from "./palette-words";

afterEach(() => setLocale("en", en));

describe("palette keywords", () => {
  it("adds nothing in English: the item's own text already matches", () => {
    expect(englishWords("palette.compose")).toEqual([]);
  });

  it("adds the English words in another language, plurals and placeholders filled in", () => {
    setLocale("es", es);
    expect(englishWords("palette.compose")).toEqual(["New message"]);
    expect(englishWords("palette.archive", { count: 3 })).toEqual(["Archive 3 conversations"]);
    expect(englishWords("palette.archive", { count: 1 })).toEqual(["Archive conversation"]);
  });
});
