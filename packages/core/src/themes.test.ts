import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, canonicalThemeId, customThemeSchema, customThemesSchema, isStyleFont, localFamily, MAX_CUSTOM_THEMES, switchDesign, THEME_COLOR_RE, THEME_TOKENS, type CustomTheme } from "./themes";

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
    expect(customThemeSchema.safeParse({ ...valid, extends: "terno-light" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, extends: "nope" }).success).toBe(false);
    expect(customThemeSchema.safeParse({ ...valid, tokens: {} }).success).toBe(false);
  });

  it("reads the default themes' Única ids as their successors", () => {
    expect(canonicalThemeId("unica-light")).toBe("terno-light");
    expect(canonicalThemeId("unica-dark")).toBe("terno-dark");
    expect(canonicalThemeId("nord")).toBe("nord");
    expect(canonicalThemeId("toString")).toBe("toString");
    expect(customThemeSchema.parse({ ...valid, extends: "unica-dark" }).extends).toBe("terno-dark");
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

  it("knows 11 light and 13 dark built-ins with unique ids", () => {
    expect(BUILTIN_THEMES.filter((t) => t.mode === "light")).toHaveLength(11);
    expect(BUILTIN_THEMES.filter((t) => t.mode === "dark")).toHaveLength(13);
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(24);
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length);
  });
});

const mine: CustomTheme = { id: "mine", name: "Mine", mode: "dark", extends: "terno-dark", tokens: { primary: "#112233" } };
const lumen = { design: "lumen" as const, lightTheme: "github-light", darkTheme: "github-dark", designPalettes: {}, customThemes: [] };

describe("switchDesign (plan 138)", () => {
  it("the palettes in use stay with the style left; a style with nothing kept has its own colors", () => {
    expect(switchDesign(lumen, "graphite")).toEqual({
      design: "graphite",
      lightTheme: "design",
      darkTheme: "design",
      designPalettes: { lumen: { light: "github-light", dark: "github-dark" } },
    });
  });

  it("a style takes back what it was left with, and its keeps are updated when it is left again", () => {
    const graphite = { ...lumen, design: "graphite" as const, lightTheme: "design", darkTheme: "nord", designPalettes: { lumen: { light: "github-light", dark: "dracula" } } };
    expect(switchDesign(graphite, "lumen")).toEqual({
      design: "lumen",
      lightTheme: "github-light",
      darkTheme: "dracula",
      designPalettes: { lumen: { light: "github-light", dark: "dracula" }, graphite: { light: "design", dark: "nord" } },
    });
  });

  it("a custom palette kept is taken back while it exists; deleted since, or a palette of the other mode, is the style's own", () => {
    const designPalettes = { graphite: { light: "dracula", dark: "custom:mine" } };
    expect(switchDesign({ ...lumen, designPalettes, customThemes: [mine] }, "graphite")).toMatchObject({ lightTheme: "design", darkTheme: "custom:mine" });
    expect(switchDesign({ ...lumen, designPalettes }, "graphite")).toMatchObject({ lightTheme: "design", darkTheme: "design" });
  });
});

describe("a style's font (plans 245, 248)", () => {
  it("is a bundled id or an installed family whose name is only a name", () => {
    for (const ok of ["inter", "system", "local:Georgia", "local:Times New Roman", "local:ヒラギノ角ゴシック", "local:Avenir Next Condensed", "local:I.M. Fell", `local:${"x".repeat(100)}`]) expect(isStyleFont(ok), ok).toBe(true);
    for (const bad of ["comic-sans", "local:", "local: Georgia", "local:Georgia ", 'local:Geo"rgia', "local:Geo'rgia", "local:a\\b", "local:a;b", "local:a{b}", "local:<b>", "local:a\nb", `local:${"x".repeat(101)}`, 42, null]) expect(isStyleFont(bad), String(bad)).toBe(false);
    expect([localFamily("local:Georgia"), localFamily("inter")]).toEqual(["Georgia", null]);
  });
});

describe("category colors (plan 194)", () => {
  it("reads a known color as itself, a retired one as its successor and anything else as slate", async () => {
    const { categoryColor, CATEGORY_COLORS } = await import("./types");
    for (const c of CATEGORY_COLORS) expect(categoryColor(c)).toBe(c);
    expect(categoryColor("indigo")).toBe("brown");
    expect(categoryColor("blue")).toBe("slate");
    expect(categoryColor(undefined)).toBe("slate");
    expect(CATEGORY_COLORS).not.toContain("indigo");
  });
  it("plan 237: a new one takes the next color after the last one's, skipping used ones while any is free", async () => {
    const { nextColor, CATEGORY_COLORS } = await import("./types");
    expect(nextColor([])).toBe("rose");
    expect(nextColor(["rose", "amber"])).toBe("lime");
    // the last one recolored: the new one follows it, never matches it
    expect(nextColor(["rose", "cyan"])).toBe("brown");
    expect(nextColor(["rose", "rose"])).toBe("amber");
    // wraps, and skips what's taken
    expect(nextColor(["amber", "slate"])).toBe("rose");
    expect(nextColor(["rose", "lime", "amber"])).toBe("emerald");
    // all eight taken: the one after the last's
    expect(nextColor([...CATEGORY_COLORS.slice(3), ...CATEGORY_COLORS.slice(0, 3)])).toBe("emerald");
    expect(nextColor([...CATEGORY_COLORS, "violet"])).toBe("slate");
    // a retired color counts as its successor, junk as slate
    expect(nextColor(["indigo"])).toBe("violet");
    expect(nextColor(["blue"])).toBe("rose");
  });
  it("lets an older backup's indigo category in, as brown; still refuses junk", async () => {
    const { exportCategorySchema } = await import("./rpc/contract");
    expect(exportCategorySchema.parse({ id: 1, name: "Dev", color: "indigo" }).color).toBe("brown");
    expect(exportCategorySchema.safeParse({ id: 1, name: "Dev", color: "blue" }).success).toBe(false);
  });
});
