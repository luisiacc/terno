/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DESIGN, DESIGN_IDS } from "@terno/core";
import { describe, expect, it } from "vitest";
import { builtinTheme } from "../themes/registry";
import { designVars, generateDesignsCss, generateTypeRolesCss } from "./generate";
import { designById, DESIGNS } from "./index";
import { TYPE_ROLES } from "./types";

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
    expect(m.rows).toEqual({ comfortable: 68, compact: 40, wide: 44 });
    expect(m.avatar.row).toBe(0);
    expect(m.palette).toEqual({ light: "terno-light", dark: "terno-dark" });
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
