import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, customThemeSchema, customThemesSchema, MAX_CUSTOM_THEMES, THEME_COLOR_RE, THEME_TOKENS } from "./themes";

const valid = { id: "mi-tema", name: "Mi tema", mode: "dark", extends: "dracula", tokens: { primary: "#ff79c6", background: "oklch(0.25 0.02 280)" } };

describe("custom theme schema", () => {
  it("accepts a valid theme with hex and oklch colors", () => {
    expect(customThemeSchema.parse(valid)).toEqual(valid);
    for (const c of ["#abc", "#abcd", "#aabbcc", "#AABBCC80", "oklch(0.5 0.1 200)", "oklch(50% 0.1 200deg)", "oklch(.5 .1 200 / .4)", "oklch(0.5 0 0 / 40%)"]) {
      expect(THEME_COLOR_RE.test(c), c).toBe(true);
    }
  });

  it("rejects anything that could escape the declaration or load something", () => {
    const evil = [
      "red;}body{display:none",
      "#fff;}html{background:url(https://x.test/p.png)",
      "url(https://x.test/p.png)",
      "var(--primary)",
      "oklch(0.5 0.1 200);color:red",
      "oklch(calc(1) 0.1 200)",
      "oklch(0.5 0.1 200) !important",
      "expression(alert(1))",
      "red",
      "#ggg",
      "#12345",
      "rgb(0 0 0)",
      "",
    ];
    for (const color of evil) {
      const r = customThemeSchema.safeParse({ ...valid, tokens: { primary: color } });
      expect(r.success, color).toBe(false);
    }
  });

  it("rejects unknown tokens, unknown keys, bad ids and a base of the other mode", () => {
    expect(customThemeSchema.safeParse({ ...valid, tokens: { "not-a-token": "#fff" } }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, tokens: { "background;color": "#fff" } }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, css: "body{}" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, id: "Mi Tema" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, id: "a".repeat(41) }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, name: "x".repeat(41) }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, extends: "unica-light" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, extends: "nope" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, tokens: {} }).success).toBe(false);
  });

  it("limits the list: at most 20 themes, unique ids, 16 KB in total", () => {
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 1 }, (_, i) => ({ ...valid, id: `t-${i}` }));
    expect(customThemesSchema.safeParse(many.slice(0, MAX_CUSTOM_THEMES)).success).toBe(true);
    expect(customThemesSchema.safeParse(many).success).toBe(false);
    expect(customThemesSchema.safeParse([valid, valid]).success).toBe(false);
    const full = Object.fromEntries(THEME_TOKENS.map((t) => [t, "oklch(0.123456 0.123456 123.456789 / 0.5)"]));
    const big = Array.from({ length: 6 }, (_, i) => ({ ...valid, id: `big-${i}`, tokens: full }));
    expect(customThemesSchema.safeParse(big).success).toBe(false);
  });

  it("knows 6 light and 7 dark built-ins with unique ids", () => {
    expect(BUILTIN_THEMES.filter((t) => t.mode === "light")).toHaveLength(6);
    expect(BUILTIN_THEMES.filter((t) => t.mode === "dark")).toHaveLength(7);
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(13);
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length);
  });
});
