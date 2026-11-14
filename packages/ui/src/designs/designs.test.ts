/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DESIGN, DESIGN_IDS } from "@terno/core";
import { describe, expect, it } from "vitest";
import { oklchToRgb, parseColor } from "../themes/color";
import { builtinTheme } from "../themes/registry";
import { DEPTHS, DEPTH_VARS } from "./depth";
import { designVars, generateDesignsCss, generateTypeRolesCss } from "./generate";
import { designById, DESIGNS } from "./index";
import { NO_PREVIEW_GAP, rowHeight } from "./rows";
import { TEXT_STEPS, TYPE_ROLES } from "./types";

const styles = join(import.meta.dirname, "../styles");
const hexOf = (color: string) => {
  const { r, g, b } = oklchToRgb(parseColor(color));
  return `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
};

describe("designs (plan 15)", () => {
  it("match core's list, with unique ids; unknown ids are the default", () => {
    expect(DESIGNS.map((d) => d.id).sort()).toEqual([...DESIGN_IDS].sort());
    expect(designById("nope").id).toBe(DEFAULT_DESIGN);
    expect(designById(null).id).toBe(DEFAULT_DESIGN);
  });

  it.each(DESIGNS.map((d) => [d.id, d] as const))("%s names a palette of each mode", (_id, d) => {
    expect(builtinTheme(d.palette.light)?.mode).toBe("light");
    expect(builtinTheme(d.palette.dark)?.mode).toBe("dark");
  });

  it("every design sets the same variables (none can be forgotten)", () => {
    const names = DESIGNS.map((d) => designVars(d).map(([k]) => k));
    for (const n of names) expect(n).toEqual(names[0]);
    expect(new Set(names[0]).size).toBe(names[0]!.length);
    for (const d of DESIGNS) for (const [k, v] of designVars(d)) expect(v, `${d.id} ${k}`).toMatch(/\S/);
  });

  it("row heights fit their avatars, and compact is shorter", () => {
    for (const d of DESIGNS) {
      expect(d.rows.compact).toBeLessThan(d.rows.comfortable);
      expect(d.avatar.row + 16).toBeLessThanOrEqual(d.rows.comfortable);
      expect(d.avatar.rowCompact + 12).toBeLessThanOrEqual(d.rows.compact);
      // plan 24: the List layout's one-line row sits between the two, with room around its avatar
      expect(d.rows.wide).toBeGreaterThan(d.rows.compact);
      expect(d.rows.wide).toBeLessThan(d.rows.comfortable);
      expect(d.avatar.rowWide + 16).toBeLessThanOrEqual(d.rows.wide);
      // no avatar in rows means none in wide rows either
      expect(d.avatar.rowWide === 0).toBe(d.avatar.row === 0);
    }
  });

  it("a three-line row has room for its lines, in a list and in a search's results (plan 158)", () => {
    for (const d of DESIGNS) {
      const px = (leading: string) => parseFloat(leading) * 16;
      const lines = px(d.type.rowFrom.leading) + px(d.type.rowSubject.leading) + px(d.type.rowSnippet.leading);
      // 5 px above and below at least, or the text sits against the selection's edges
      expect(d.rows.comfortable, d.id).toBeGreaterThanOrEqual(lines + 10);
      expect(d.rows.results, d.id).toBeGreaterThanOrEqual(lines + 10);
    }
  });

  it("with no preview, a row still has room for its two lines and its avatar (plan 187)", () => {
    for (const d of DESIGNS) {
      // rowHeight reads the preview's leading in px: it must be rem
      expect(d.type.rowSnippet.leading, d.id).toMatch(/^\d+(\.\d+)?rem$/);
      const px = (leading: string) => parseFloat(leading) * 16;
      const none = rowHeight(d, { compact: false, wide: false, results: false, lines: 0 });
      expect(none, d.id).toBeGreaterThanOrEqual(px(d.type.rowFrom.leading) + px(d.type.rowSubject.leading) + NO_PREVIEW_GAP + 10);
      expect(d.avatar.row + 16, d.id).toBeLessThanOrEqual(none);
    }
  });

  it("macOS: SF, the dense scale, 64/32 px rows, no avatars in rows", () => {
    const m = designById("macos");
    expect(m.fonts.sans).toMatch(/^-apple-system, BlinkMacSystemFont, "Geist Variable"/);
    expect(m.text.sm).toEqual(["0.8125rem", "1.125rem"]);
    expect(m.radius.md).toBe("0.375rem");
    expect(m.rows).toEqual({ comfortable: 64, compact: 32, wide: 36, results: 64 });
    expect(m.avatar.row).toBe(0);
    expect(m.palette).toEqual({ light: "terno-light", dark: "terno-dark" });
  });

  // plan 137: the blueprint, value by value (e2e/graphite.spec.ts checks what the running app draws)
  describe("Graphite holds its blueprint", () => {
    const g = designById("graphite");
    const px = (rem: string) => parseFloat(rem) * 16;
    const hex = (color: string) => {
      const { r, g: green, b } = oklchToRgb(parseColor(color));
      return `#${[r, green, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    };

    it("type: 12, 13, 14 and 24 px; grey in regular and medium, the ink half a step heavier (plan 174); -0.15px", () => {
      for (const step of TEXT_STEPS) expect([12, 13, 14, 24]).toContain(px(g.text[step][0]));
      expect([12, 13, 14, 24]).toContain(px(g.controlText));
      const grey = ["listSubtitle", "sectionLabel", "nav", "rowSnippet"];
      for (const role of TYPE_ROLES) {
        const spec = g.type[role];
        expect([12, 13, 14, 24], role).toContain(px(spec.size));
        expect(grey.includes(role) ? [400] : [450, 550], role).toContain(spec.weight);
        // a read sender is 550, so an unread one needs the step above it
        expect(role === "rowFrom" ? [650] : [400, 500, 550], role).toContain(spec.strong);
        expect(spec.tracking, role).toBe("-0.15px");
      }
      expect(g.weights).toEqual({ semibold: 500, bold: 500 });
      expect(g.tracking).toEqual({ tight: "-0.15px", display: "-0.15px", base: "-0.15px", wide: "-0.15px" });
    });

    it("shape: 8 px navigation, 16 px cards, pill buttons, 14 px navigation icons", () => {
      expect(px(g.layout.navRadius)).toBe(8);
      expect(px(g.layout.cardRadius)).toBe(16);
      expect(px(g.radius["2xl"])).toBe(16);
      expect(g.surfaces.cta).toBe("pill");
      expect(g.icon.nav).toBe(14);
    });

    it("hierarchy: #171717 and #5D5D5D in light, #EDEDED and #AAAAAA in dark (#A4A4A4 in its sidebar)", () => {
      const light = builtinTheme("graphite-light")!.tokens;
      const dark = builtinTheme("graphite-dark")!.tokens;
      expect([light.foreground, light.primary, light["muted-foreground"]].map(hex)).toEqual(["#171717", "#171717", "#5D5D5D"]);
      expect([dark.foreground, dark["muted-foreground"]].map(hex)).toEqual(["#EDEDED", "#AAAAAA"]);
    });
  });

  it("the values Graphite added leave the other designs as they were", () => {
    // (plan 204: Relief came after, and decides these for itself)
    for (const d of DESIGNS.filter((x) => x.id !== "graphite" && x.id !== "relief")) {
      expect(d.weights, d.id).toEqual({ semibold: 600, bold: 700 });
      expect(d.tracking.base, d.id).toBe("normal");
      expect(d.icon.nav, d.id).toBe(16);
      expect(d.surfaces.cta, d.id).toBe("control");
      expect(d.surfaces.card, d.id).toBe("tint");
      expect(d.controlText, d.id).toBe("0.8rem");
      expect(d.tracking.wide, d.id).toBe("0.025em");
      expect(d.layout.commandRadius, d.id).toBe("var(--ds-radius-xl)");
    }
  });

  describe("depth (plan 204)", () => {
    it("every design but Relief is flat, and flat is exactly what the controls drew before", () => {
      expect(DESIGNS.filter((d) => d.surfaces.depth !== "flat").map((d) => d.id)).toEqual(["relief"]);
      const xs = "0 1px 2px 0 color-mix(in oklab, var(--shadow-color) 50%, transparent)";
      expect(DEPTHS.flat).toEqual({
        "--depth-raised": xs,
        "--depth-raised-sheen": "none",
        "--depth-edge": "var(--border)",
        "--depth-edge-firm": "var(--input)",
        "--depth-segment": xs,
        "--depth-segment-dark": "inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)",
        "--depth-ink": "inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)",
        "--depth-box": xs,
        "--depth-box-on": "inset 0 1px var(--highlight)",
        "--depth-thumb": "0 3px 3px 0 color-mix(in oklab, var(--shadow-color) 30%, transparent), 0 0.75px 0 0 color-mix(in oklab, var(--shadow-color) 50%, transparent)",
        "--depth-thumb-dark": "var(--foreground)",
        "--depth-thumb-dark-shade": "color-mix(in oklab, var(--foreground) 88%, var(--background))",
        "--depth-thumb-chip": "1",
        "--depth-track": "var(--control-edge)",
        "--depth-track-dark": "color-mix(in oklab, var(--control-edge) 80%, transparent)",
        "--depth-switch-off": "0 0 transparent",
        "--depth-switch-on": "inset 0 1px var(--highlight)",
        "--depth-well": "0 0 transparent",
        "--depth-field": "0 0 transparent",
        "--depth-card": "0 0 transparent",
        "--depth-card-sheen": "none",
        "--depth-nav": "0 0 transparent",
        "--emboss": "none",
      });
    });

    it("every design's block sets every depth variable, over palette tokens only (no @theme alias, no colour)", () => {
      for (const d of DESIGNS) {
        const vars = new Map(designVars(d));
        for (const name of DEPTH_VARS) expect(vars.get(name), `${d.id} ${name}`).toBe(DEPTHS[d.surfaces.depth][name]);
      }
      for (const preset of Object.values(DEPTHS))
        for (const [name, value] of Object.entries(preset)) {
          // a root alias (--shadow-xs) would resolve against the outer palette in a nested preview
          expect(value, name).not.toMatch(/var\(--shadow-(?!color)/);
          expect(value, name).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgba?\(/i);
        }
    });

    it("Relief is raised: its cards on the card's fill, its palette the pictures' greys (the reading surface a step lighter: UI rating relief-r01)", () => {
      const r = designById("relief");
      expect(r.surfaces).toMatchObject({ card: "raised", depth: "relief", cta: "pill" });
      expect(new Map(designVars(r)).get("--card-bg")).toBe("var(--card)");
      const light = builtinTheme("relief-light")!.tokens;
      const dark = builtinTheme("relief-dark")!.tokens;
      expect([light.background, light.foreground, light["muted-foreground"], light.primary].map(hexOf)).toEqual(["#EFEFEF", "#1F1F1F", "#565656", "#1C1C1C"]);
      expect([dark.background, dark.foreground].map(hexOf)).toEqual(["#1E1E1E", "#EDEDED"]);
    });
  });

  it("plan 204 (after relief-r03): Relief alone sets read rows back, by weight and ink; every other design keeps the row's ink", () => {
    expect(DESIGNS.filter((d) => d.surfaces.readRow !== "ink").map((d) => d.id)).toEqual(["relief"]);
    for (const d of DESIGNS) expect(new Map(designVars(d)).get("--row-read-ink"), d.id).toBe(d.surfaces.readRow === "soft" ? "var(--row-read)" : "var(--foreground)");
    const { rowFrom, rowSubject } = designById("relief").type;
    expect([rowFrom.weight, rowFrom.strong, rowSubject.weight, rowSubject.strong]).toEqual([500, 650, 400, 650]);
  });

  it("generated CSS is up to date (run `pnpm --filter @terno/ui gen:designs`)", () => {
    expect(readFileSync(join(styles, "designs.generated.css"), "utf8")).toBe(generateDesignsCss());
    expect(readFileSync(join(styles, "type-roles.generated.css"), "utf8")).toBe(generateTypeRolesCss());
  });

  it("has one block per design and a type-<role> pair per role, imported by globals.css", () => {
    const css = generateDesignsCss();
    for (const d of DESIGNS) expect(css).toContain(`[data-design="${d.id}"]`);
    const roles = generateTypeRolesCss();
    for (const r of TYPE_ROLES) {
      const k = r.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(roles).toContain(`@utility type-${k} {`);
      expect(roles).toContain(`@utility type-${k}-strong {`);
    }
    const globals = readFileSync(join(styles, "globals.css"), "utf8");
    expect(globals).toContain('@import "./designs.generated.css";');
    expect(globals).toContain('@import "./type-roles.generated.css";');
    // type, radius and fonts come from the design, not literals
    expect(globals).toMatch(/--text-sm: var\(--ds-text-sm\);/);
    expect(globals).toMatch(/--radius-md: var\(--ds-radius-md\);/);
    expect(globals).toMatch(/--font-sans: var\(--ds-font-sans\);/);
  });
});
