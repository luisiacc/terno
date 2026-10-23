import { THEME_TOKENS } from "@unica/core";
import { describe, expect, it } from "vitest";
import { applyCustomTheme, clampMotion, motionOff, motionVars } from "./apply";
import { builtinTheme } from "./registry";

describe("motion variables", () => {
  it("derives fast/base/slow from the setting, never slower than 100 ms", () => {
    expect(motionVars(75)).toEqual({ "--motion": "75ms", "--motion-fast": "50ms", "--motion-base": "75ms", "--motion-slow": "100ms" });
    expect(motionVars(100)).toEqual({ "--motion": "100ms", "--motion-fast": "66ms", "--motion-base": "100ms", "--motion-slow": "100ms" });
    expect(motionVars(50)).toEqual({ "--motion": "50ms", "--motion-fast": "33ms", "--motion-base": "50ms", "--motion-slow": "67ms" });
    expect(motionVars(0)).toEqual({ "--motion": "0ms", "--motion-fast": "0ms", "--motion-base": "0ms", "--motion-slow": "0ms" });
    expect(motionVars(400)["--motion-slow"]).toBe("100ms");
  });

  it("is off at 0 or under reduced motion", () => {
    expect(motionOff(0, false)).toBe(true);
    expect(motionOff(75, true)).toBe(true);
    expect(motionOff(75, false)).toBe(false);
  });

  it("only accepts the four steps", () => {
    expect(clampMotion(50)).toBe(50);
    expect(clampMotion(0)).toBe(0);
    expect(clampMotion(60)).toBe(75);
    expect(clampMotion("100")).toBe(75);
  });
});

describe("applyCustomTheme", () => {
  it("sets every token through setProperty and removes them all again", () => {
    const props = new Map<string, string>();
    const style = { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => (props.delete(k), "") };
    const theme = builtinTheme("nord")!;
    applyCustomTheme(style, theme);
    expect(props.size).toBe(THEME_TOKENS.length);
    expect(props.get("--background")).toBe(theme.tokens.background);
    applyCustomTheme(style, null);
    expect(props.size).toBe(0);
  });
});

describe("opaqueBackground", () => {
  it("is always #rrggbb; a translucent custom background is composited over its mode's default", async () => {
    const { opaqueBackground } = await import("./apply");
    const { resolveCustomTheme } = await import("./registry");
    const { toHex } = await import("./color");
    expect(opaqueBackground(builtinTheme("nord")!)).toBe(toHex(builtinTheme("nord")!.tokens.background));
    const glassy = resolveCustomTheme({ id: "glass", name: "Glass", mode: "light", extends: "github-light", tokens: { background: "#aabbcc80" } });
    const out = opaqueBackground(glassy);
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    // half #aabbcc over Única claro's paper (≈ #fcfcfa)
    expect(out).toBe("#d3dbe3");
  });
});
