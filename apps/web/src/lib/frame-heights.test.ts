import { describe, expect, it } from "vitest";
import { frameHeight, rememberHeight, standIn } from "./frame-heights";

describe("frame heights", () => {
  it("a stand-in opens at its source's height as measured when it opens, until it measures its own", () => {
    rememberHeight(-1, 234);
    standIn(900, -1);
    // measured again meanwhile (the window resized): the latest, never the one there when the stand-in was said
    rememberHeight(-1, 158);
    expect(frameHeight(900)).toBe(158);
    rememberHeight(900, 170);
    rememberHeight(-1, 300);
    expect(frameHeight(900)).toBe(170);
  });

  it("said before its source is measured, it still finds it; a body measured already keeps its own", () => {
    standIn(901, -2);
    expect(frameHeight(901)).toBeUndefined();
    rememberHeight(-2, 44);
    expect(frameHeight(901)).toBe(44);
    rememberHeight(902, 80);
    standIn(902, -2);
    expect(frameHeight(902)).toBe(80);
  });
});
