import { describe, expect, it } from "vitest";
import { contrastFailures, CONTRAST_PAIRS } from "./contrast";
import { THEMES } from "./registry";

describe("WCAG AA in every built-in theme", () => {
  it.each(THEMES.map((t) => [t.id, t] as const))("%s passes every pair", (_id, theme) => {
    const failures = contrastFailures(theme).map((f) => `${theme.id}: ${f.pair} = ${f.ratio} (needs ${f.min})`);
    expect(failures).toEqual([]);
  });

  it("checks the pairs the plan requires", () => {
    // 9 + 9 fg/muted-fg surfaces, 8 single text pairs, 8 badge inks, 5 UI pairs, 8 dots
    expect(CONTRAST_PAIRS).toHaveLength(47);
  });

  it("reports a failing pair with its ratio", () => {
    const broken = { tokens: { ...THEMES[0]!.tokens, "muted-foreground": "oklch(0.8 0 0)" } };
    const f = contrastFailures(broken);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatchObject({ pair: "muted-foreground / background", min: 4.5 });
    expect(f[0]!.ratio).toBeLessThan(2);
  });
});
