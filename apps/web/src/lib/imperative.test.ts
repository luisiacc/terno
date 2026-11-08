import { describe, expect, it } from "vitest";
import { isInstruction } from "./imperative";

describe("an instruction typed in ⌘K (plan 161, pass 3)", () => {
  it("a sentence that starts with a mail action is one, in English and Spanish", () => {
    for (const s of [
      "Archive shipping notices older than a month",
      "delete all newsletters from Netflix",
      "Move receipts from Uber to Travel",
      "mark everything from GitHub as read",
      "Archiva los envíos de más de un mes",
      "Mueve los recibos de Uber a Viajes",
      "marca todo lo de GitHub como leído",
    ])
      expect(isInstruction(s), s).toBe(true);
  });

  it("a search keeps the search first: one verb, a short phrase, an operator, quotes, a name", () => {
    for (const s of ["archive", "delete account", "archive old mail", "Mark Twain letters to Olivia", "from:ana archive old mail", "archive \"weekly report\" from bob", "invoice March from Uber", "what did Isabella say about the payment?", "move to Berlin"])
      expect(isInstruction(s), s).toBe(false);
  });
});
