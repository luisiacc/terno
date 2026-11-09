import { describe, expect, it } from "vitest";
import { noteState } from "./ai-draft-state";

describe("plan 162 (after ai162-r04): a note for AI", () => {
  it("is an instruction, or what's typed after ⌘J opened it for AI when the rules can't tell", () => {
    expect(noteState(undefined, "write")).toBe(true);
    expect(noteState("primed", "write")).toBe(true);
    expect(noteState("primed", "unsure")).toBe(true);
  });
  it("stays one when AI couldn't write and nothing of its own landed (Couldn't reach Claude left Send the primary)", () => {
    expect(noteState("failed", "write")).toBe(true);
    expect(noteState("failed", "unsure")).toBe(true);
    expect(noteState("failed", "")).toBe(false);
    expect(noteState("failed", "empty")).toBe(false);
  });
  it("never a plain draft, an email with gaps, an empty body, or while AI works or holds its draft", () => {
    expect(noteState(undefined, "unsure")).toBe(false);
    expect(noteState(undefined, "")).toBe(false);
    expect(noteState("primed", "")).toBe(false);
    expect(noteState("primed", "empty")).toBe(false);
    expect(noteState(undefined, "fill:2")).toBe(false);
    for (const row of ["open", "writing", "ready"] as const) expect(noteState(row, "write")).toBe(false);
  });
});
