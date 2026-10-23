import { describe, expect, it } from "vitest";
import { formatAddressList, parseAddressList } from "./address";

describe("addresses", () => {
  it("a display name containing an address and a comma can't inject a recipient", () => {
    const sender = { name: "leak@attacker.example, Support", email: "support@company.example" };
    const formatted = formatAddressList([sender]);
    expect(formatted).toBe('"leak@attacker.example, Support" <support@company.example>');
    expect(parseAddressList(formatted)).toEqual([sender]);
  });

  it("round-trips names with quotes, commas and accents", () => {
    const list = [
      { name: 'Pérez, "Lucho"', email: "luis@x.mx" },
      { name: "Ana", email: "ana@y.com" },
      { name: "", email: "bob@z.com" },
    ];
    expect(parseAddressList(formatAddressList(list))).toEqual(list);
  });

  it("parses typical hand-typed input", () => {
    expect(parseAddressList("ana@y.com; Bob <bob@z.com>\n, ,")).toEqual([
      { name: "", email: "ana@y.com" },
      { name: "Bob", email: "bob@z.com" },
    ]);
  });
});
