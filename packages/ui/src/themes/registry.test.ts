import { BUILTIN_THEMES, customThemeSchema, DEFAULT_THEME, THEME_TOKENS } from "@terno/core";
import { describe, expect, it } from "vitest";
import { contrast, parseColor } from "./color";
import { builtinTheme, glassAlpha, resolveCustomTheme, THEMES, themesFor } from "./registry";

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
    const light = builtinTheme("terno-light")!.tokens;
    const dark = builtinTheme("terno-dark")!.tokens;
    expect(light["card-foreground"]).toBe(light.foreground);
    expect(light["sidebar-primary"]).toBe(light.primary);
    expect(light["row-rail"]).toBe(light.primary);
    expect(light.secondary).toBe(light.muted);
    // ring: primary at the lowest alpha ≥ .55 that still reaches 3:1 on the background and on the sidebar
    expect(parseColor(light.ring).alpha).toBe(0.8);
    expect(parseColor(dark.ring).alpha).toBe(0.6);
    expect(parseColor(light.overlay).alpha).toBe(0.1);
    expect(parseColor(dark.overlay).alpha).toBe(0.45);
    expect(parseColor(dark["sidebar-translucent"]).alpha).toBe(0.62);
  });

  it("only Única and Apple sit on the native vibrancy; Apple uses the system font", () => {
    expect(THEMES.filter((t) => t.vibrancy).map((t) => t.id)).toEqual(["terno-light", "apple-light", "terno-dark"]);
    expect(builtinTheme("apple-light")!.font).toContain("-apple-system");
  });
});

describe("plan 07 tokens", () => {
  it("hairline is ink at 9 % / 8 %; highlight is white at 16 % / 6 %", () => {
    expect(parseColor(builtinTheme("terno-light")!.tokens.hairline).alpha).toBe(0.09);
    expect(parseColor(builtinTheme("terno-dark")!.tokens.hairline).alpha).toBe(0.08);
    expect(parseColor(builtinTheme("terno-light")!.tokens.highlight).alpha).toBe(0.16);
    expect(parseColor(builtinTheme("nord")!.tokens.highlight).alpha).toBe(0.06);
  });

  it("tint sits between the background and the ink, and text on it still reads", () => {
    for (const t of THEMES) {
      const [bg, tint, fg] = [t.tokens.background, t.tokens.tint, t.tokens.foreground].map((c) => parseColor(c).l);
      expect(Math.abs(tint! - bg!), t.id).toBeLessThanOrEqual(Math.abs(fg! - bg!) * 0.06);
      expect(contrast(t.tokens["muted-foreground"], t.tokens.tint, t.tokens.background), t.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the draft label steps away from destructive only when a row would make it unreadable", () => {
    // Dracula's destructive reads at 3.52:1 on its selected row: stepped lighter
    const dracula = builtinTheme("dracula")!.tokens;
    expect(parseColor(dracula["draft-foreground"]).l).toBeGreaterThan(parseColor(dracula.destructive).l);
    expect(contrast(dracula["draft-foreground"], dracula["row-selected"])).toBeGreaterThanOrEqual(4.5);
    // GitHub's reads everywhere already: unchanged
    const gh = builtinTheme("github-light")!.tokens;
    expect(gh["draft-foreground"]).toBe(gh.destructive);
  });

  it("menus are translucent only as far as their text stays readable over black and white", () => {
    const white = parseColor("oklch(1 0 0)");
    // dark ink reads on a white menu over anything at the lowest alpha
    expect(glassAlpha(white, [parseColor("oklch(0.15 0 0)")])).toBe(0.88);
    // light grey text on a white menu fails over black until the menu is solid enough
    expect(glassAlpha(white, [parseColor("oklch(0.56 0 0)")])).toBeGreaterThan(0.88);
    // Nord's muted text would read 3.74:1 at 88 % over white: its menus go solid
    expect(parseColor(builtinTheme("nord")!.tokens["popover-glass"]).alpha).toBe(1);
  });

  it("custom themes re-derive the plan 07 tokens from their own colors", () => {
    const custom = customThemeSchema.parse({ id: "gris", name: "Gris", mode: "light", extends: "terno-light", tokens: { popover: "#f0f0f0", "muted-foreground": "#777777" } });
    const t = resolveCustomTheme(custom);
    expect(t.tokens["popover-glass"]).not.toBe(builtinTheme("terno-light")!.tokens["popover-glass"]);
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
