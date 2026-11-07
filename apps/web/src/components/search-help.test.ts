import { describe, expect, it } from "vitest";
import { picked } from "./search-help";

describe("a search help row put to use (plan 158)", () => {
  it("types its operator alone into an empty field", () => {
    expect(picked("from:ana", undefined, "")).toBe("from:");
    expect(picked("has:attachment", "whole", "")).toBe("has:attachment ");
    expect(picked('"exact words"', "quote", "")).toBe('"');
  });

  it("puts a word that found nothing to use", () => {
    expect(picked("from:ana", undefined, "pago")).toBe("from:pago");
    expect(picked("has:attachment", "whole", "pago")).toBe("pago has:attachment ");
    expect(picked("in:archive", "value", "pago")).toBe("pago in:archive ");
    expect(picked('"exact words"', "quote", "pago mayo")).toBe('"pago mayo"');
  });

  it("keeps several words, operators and quotes as they are, the row after them", () => {
    expect(picked("from:ana", undefined, "invoice may")).toBe("invoice may from:");
    expect(picked("from:ana", undefined, "from:ana")).toBe("from:ana from:");
    expect(picked('"exact words"', "quote", '"exact words"')).toBe('"exact words" "');
  });
});
