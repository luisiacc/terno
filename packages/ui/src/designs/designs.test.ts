/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DESIGN, DESIGN_IDS } from "@terno/core";
import { describe, expect, it } from "vitest";
import { oklchToRgb, parseColor } from "../themes/color";
import { builtinTheme } from "../themes/registry";
import { designVars, generateDesignsCss, generateTypeRolesCss } from "./generate";
import { designById, DESIGNS } from "./index";
import { TEXT_STEPS, TYPE_ROLES } from "./types";

const styles = join(import.meta.dirname, "../styles");

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

  it("macOS keeps the app as it was: SF, the dense scale, 68/40 px rows, no avatars in rows", () => {
    const m = designById("macos");
    expect(m.fonts.sans).toMatch(/^-apple-system, BlinkMacSystemFont, "Geist Variable"/);
    expect(m.text.sm).toEqual(["0.8125rem", "1.125rem"]);
    expect(m.radius.md).toBe("0.375rem");
    expect(m.rows).toEqual({ comfortable: 68, compact: 40, wide: 44, results: 56 });
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

    it("type: 12, 13, 14 and 24 px, regular and medium, -0.15px", () => {
      for (const step of TEXT_STEPS) expect([12, 13, 14, 24]).toContain(px(g.text[step][0]));
      expect([12, 13, 14, 24]).toContain(px(g.controlText));
      for (const role of TYPE_ROLES) {
        const spec = g.type[role];
        expect([12, 13, 14, 24], role).toContain(px(spec.size));
        expect([400, 500], role).toContain(spec.weight);
        expect([400, 500], role).toContain(spec.strong);
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

    it("hierarchy: #292929 and #5D5D5D in light, #EDEDED and #9E9E9E in dark", () => {
      const light = builtinTheme("graphite-light")!.tokens;
      const dark = builtinTheme("graphite-dark")!.tokens;
      expect([light.foreground, light.primary, light["muted-foreground"]].map(hex)).toEqual(["#292929", "#292929", "#5D5D5D"]);
      expect([dark.foreground, dark["muted-foreground"]].map(hex)).toEqual(["#EDEDED", "#9E9E9E"]);
    });
  });

  it("the values Graphite added leave the other designs as they were", () => {
    for (const d of DESIGNS.filter((x) => x.id !== "graphite")) {
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
