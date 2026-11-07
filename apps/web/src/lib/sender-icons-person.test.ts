import { describe, expect, it } from "vitest";
import { iconStandsFor } from "./sender-icons";

describe("whose icon an avatar shows (plan 158)", () => {
  it("a person keeps their photo; a website's icon of any size isn't them", () => {
    expect(iconStandsFor({ kind: "photo" }, true)).toBe(true);
    expect(iconStandsFor({ kind: "site" }, true)).toBe(false);
  });
  it("a company or an automated sender shows its website's icon", () => {
    expect(iconStandsFor({ kind: "site" }, false)).toBe(true);
  });
});
