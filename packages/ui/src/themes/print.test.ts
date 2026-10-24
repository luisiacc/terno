import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import { PRINT_INK } from "./print";

describe("print palette", () => {
  it("every text ink reads at AA on the page", () => {
    for (const ink of ["text", "secondary", "tertiary", "quote", "link"] as const) expect(contrast(PRINT_INK[ink], PRINT_INK.paper), ink).toBeGreaterThanOrEqual(4.5);
  });
});
