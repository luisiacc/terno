import { normalizeError } from "@terno/core/diag";
import { describe, expect, it } from "vitest";
import { IGNORED, windowError } from "./window-error";

describe("windowError (plan 231)", () => {
  it("reports the event's own error, whatever was thrown", () => {
    const err = new TypeError("boom");
    expect(windowError({ error: err, message: "Uncaught TypeError: boom" })).toBe(err);
    for (const thrown of [0, false, ""]) expect(windowError({ error: thrown, message: "x" })).toBe(thrown);
    // a real error is reported even when its message reads like the Resize Observer's notice
    const look = new Error("ResizeObserver loop limit exceeded");
    expect(windowError({ error: look, message: look.message })).toBe(look);
  });

  it("ignores the Resize Observer's loop notice, in both spellings", () => {
    expect(windowError({ error: null, message: "ResizeObserver loop completed with undelivered notifications." })).toBe(IGNORED);
    expect(windowError({ error: undefined, message: "ResizeObserver loop limit exceeded" })).toBe(IGNORED);
    expect(windowError({ error: null, message: "ResizeObserver loop is something else" })).not.toBe(IGNORED);
  });

  it("an event without an error: a stand-in named ErrorEvent, with no frames and none of the event's text", () => {
    for (const e of [{ error: null, message: "Uncaught null" }, { error: undefined }, { error: null, message: "Script error." }]) {
      const stand = windowError(e);
      expect(stand).toBeInstanceOf(Error);
      expect((stand as Error).message).toBe("");
      // TERNO-1: the only frame was this listener's own stand-in, so the report blamed our handler
      expect(normalizeError(stand)).toEqual({ name: "ErrorEvent", frames: [] });
    }
  });
});
