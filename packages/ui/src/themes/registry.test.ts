import { BUILTIN_THEMES, customThemeSchema, DEFAULT_THEME, THEME_TOKENS } from "@unica/core";
import { describe, expect, it } from "vitest";
import { contrast, parseColor } from "./color";
import { builtinTheme, resolveCustomTheme, THEMES, themesFor } from "./registry";

describe("theme registry", () => {
  it("matches core's built-in list, in order, with unique ids", () => {
    expect(THEMES.map((t) => ({ id: t.id, mode: t.mode }))).toEqual(BUILTIN_THEMES.map((t) => ({ id: t.id, mode: t.mode })));
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(themesFor("light")).toHaveLength(6);
    expect(themesFor("dark")).toHaveLength(7);
  });

  it("has defaults for both modes", () => {
    expect(builtinTheme(DEFAULT_THEME.light)?.mode).toBe("light");
    expect(builtinTheme(DEFAULT_THEME.dark)?.mode).toBe("dark");
  });

  it("gives every theme every token as a parseable oklch color", () => {
    for (const t of THEMES) {
      expect(Object.keys(t.tokens).sort()).toEqual([...THEME_TOKENS].sort());
      for (const [k, v] of Object.entries(t.tokens)) {
        expect(v, `${t.id} ${k}`).toMatch(/^oklch\(/);
        expect(() => parseColor(v)).not.toThrow();
      }
    }
  });

  it("derives tokens: copies, ring alpha, light/dark chrome", () => {
    const light = builtinTheme("unica-light")!.tokens;
    const dark = builtinTheme("unica-dark")!.tokens;
    expect(light["card-foreground"]).toBe(light.foreground);
    expect(light["sidebar-primary"]).toBe(light.primary);
    expect(light["row-rail"]).toBe(light.primary);
    expect(light.secondary).toBe(light.muted);
    // ring: primary at the lowest alpha ≥ .55 that still reaches 3:1
    expect(parseColor(light.ring).alpha).toBe(0.75);
    expect(parseColor(dark.ring).alpha).toBe(0.6);
    expect(parseColor(light.overlay).alpha).toBe(0.1);
    expect(parseColor(dark.overlay).alpha).toBe(0.45);
    expect(parseColor(dark["sidebar-translucent"]).alpha).toBe(0.62);
  });

  it("only Única and Apple sit on the native vibrancy; Apple uses the system font", () => {
    expect(THEMES.filter((t) => t.vibrancy).map((t) => t.id)).toEqual(["unica-light", "apple-light", "unica-dark"]);
    expect(builtinTheme("apple-light")!.font).toContain("-apple-system");
  });
});

describe("custom themes", () => {
  it("extend a built-in to a full map and re-derive what follows from their colors", () => {
    const custom = customThemeSchema.parse({ id: "rosa", name: "Rosa", mode: "dark", extends: "dracula", tokens: { primary: "#ff79c6", "cat-rose": "oklch(0.7 0.2 0)" } });
    const t = resolveCustomTheme(custom);
    const base = builtinTheme("dracula")!.tokens;
    expect(t.id).toBe("custom:rosa");
    expect(Object.keys(t.tokens)).toHaveLength(THEME_TOKENS.length);
    expect(t.tokens.background).toBe(base.background);
    expect(t.tokens.primary).not.toBe(base.primary);
    // derived from the new primary
    expect(t.tokens["row-rail"]).toBe(t.tokens.primary);
    expect(t.tokens["chart-1"]).toBe(t.tokens.primary);
    expect(t.tokens["cat-rose"]).toBe("oklch(0.7 0.2 0)");
    expect(contrast(t.tokens["cat-rose-ink"], { ...parseColor(t.tokens["cat-rose"]), alpha: 0.15 }, t.tokens.background)).toBeGreaterThanOrEqual(4.5);
  });
});
