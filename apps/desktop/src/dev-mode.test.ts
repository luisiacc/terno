import { describe, expect, it } from "vitest";
import { devModeOf } from "./dev-mode";

describe("devModeOf (plan 146)", () => {
  it("is only a local run on the dev server", () => {
    expect(devModeOf({ devUrl: "http://localhost:5173", packaged: false })).toBe(true);
    expect(devModeOf({ devUrl: undefined, packaged: false })).toBe(false);
    expect(devModeOf({ devUrl: "http://localhost:5173", packaged: true })).toBe(false);
  });
});
