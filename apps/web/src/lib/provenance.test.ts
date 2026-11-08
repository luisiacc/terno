import { describe, expect, it } from "vitest";
import { provenanceDetail, provenanceLabel } from "./provenance";

describe("who wrote an AI text, said one way (plan 161)", () => {
  it("is never a bare model id on screen; the model and the caution are behind it", () => {
    expect(provenanceLabel()).toBe("Written with AI");
    const detail = provenanceDetail("qwen3:8b", Date.UTC(2026, 10, 8, 15, 27));
    expect(detail).toMatch(/^Written by qwen3:8b, .+\. It can make mistakes\.$/);
  });
});
