// @vitest-environment jsdom
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { topicHelp } = await import("./category-snackbar");

afterEach(() => setLocale("en", en));

describe("topicHelp: what 4 files, in words (plan 81)", () => {
  it("names the checked words, joined and quoted, and the category", () => {
    expect(topicHelp("Facturas", ["api", "pagos"], null)).toBe(
      "Moves every conversation that mentions “api” and “pagos” to Facturas, from all your mail. Click a word to add or remove it.",
    );
    expect(topicHelp("Facturas", ["api", "pagos", "uber"], null)).toContain("“api”, “pagos”, and “uber”");
  });

  it("says the More… text when there is some, the words when it is blank", () => {
    expect(topicHelp("Facturas", ["api"], "  recibo from:x  ")).toBe("Moves every conversation that matches “recibo from:x” to Facturas, from all your mail.");
    // a blank More… still files the checked words: the help says them
    expect(topicHelp("Facturas", ["api"], "   ")).toContain("mentions “api”");
  });

  it("says how to start with nothing checked", () => {
    expect(topicHelp("Facturas", [], null)).toBe("Check a word to move every conversation that mentions it to Facturas.");
  });

  it("speaks Spanish, with its own quotes and conjunction", () => {
    setLocale("es", es);
    expect(topicHelp("Facturas", ["api", "pagos"], null)).toBe(
      "Mueve a Facturas todas las conversaciones que mencionan «api» y «pagos», de todo tu correo. Haz clic en una palabra para añadirla o quitarla.",
    );
    expect(topicHelp("Facturas", [], null)).toBe("Marca una palabra para mover a Facturas todas las conversaciones que la mencionan.");
  });
});
