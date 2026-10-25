import { describe, expect, it } from "vitest";
import { contrastFailures, CONTRAST_PAIRS, STAR_ON_ROWS } from "./contrast";
import { THEMES } from "./registry";

describe("WCAG AA in every built-in theme", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s passes every pair", (_id, theme) => {
    const failures = contrastFailures(theme).map((f) => `${theme.id}: ${f.pair} = ${f.ratio} (needs ${f.min})`);
    expect(failures).toEqual([]);
  });

  it.each(["lumen-light", "lumen-dark", "atelier-light", "atelier-dark"])("%s keeps its star readable on hovered, selected and checked rows", (id) => {
    expect(contrastFailures(THEMES.find((t) => t.id === id)!, STAR_ON_ROWS)).toEqual([]);
  });

  it("checks the pairs the plan requires", () => {
    // 9 + 9 fg/muted-fg surfaces, 8 single text pairs + 2 on the mail paper, 8 badge inks, 5 UI pairs, 8 dots;
    // plan 07: fg + muted-fg on tint, the draft label on 4 surfaces, sidebar glyphs on 2, 3 menu texts over black and white
    // plan 08: error and "saved" inks on background, tint (and menus); the ring on tint and the sidebar, an on switch on tint; sidebar text
    // plan 15: unread ink on 4 surfaces, 8 badge inks over 5 row/draft surfaces
    expect(CONTRAST_PAIRS).toHaveLength(49 + 2 + 4 + 2 + 6 + 5 + 3 + 3 + 4 + 40);
  });

  it("reports a failing pair with its ratio", () => {
    const broken = { tokens: { ...THEMES[0]!.tokens, "muted-foreground": "oklch(0.8 0 0)" } };
    const f = contrastFailures(broken);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatchObject({ pair: "muted-foreground / background", min: 4.5 });
    expect(f[0]!.ratio).toBeLessThan(2);
  });
});
