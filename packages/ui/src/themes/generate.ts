import { THEME_TOKENS } from "@terno/core";
import { THEMES, type Theme } from "./registry";

export const GENERATED_HEADER = "/* Generated from packages/ui/src/themes/registry.ts by `pnpm --filter @terno/ui gen:themes`. Do not edit. */";

function block(theme: Theme, selector: string): string {
  const lines = [`  color-scheme: ${theme.mode};`, ...THEME_TOKENS.map((k) => `  --${k}: ${theme.tokens[k]};`)];
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/**
 * One `[data-theme="id"]` block per built-in theme. Attribute selectors (not
 * `:root[…]`) so a preview card can nest any theme; `:root` falls back to the
 * first theme (Terno claro) before theme.js has run.
 */
export function generateThemesCss(themes: readonly Theme[] = THEMES): string {
  const [first, ...rest] = themes;
  if (!first) return `${GENERATED_HEADER}\n`;
  return [GENERATED_HEADER, block(first, `:root,\n[data-theme="${first.id}"]`), ...rest.map((t) => block(t, `[data-theme="${t.id}"]`))].join("\n\n") + "\n";
}
