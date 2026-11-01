import type { CategoryColor } from "@terno/core";

/** Each palette color's accessible name, as a key (read at render, in the current language). */
export const COLOR_LABEL = {
  rose: "settings.color.rose",
  amber: "settings.color.amber",
  lime: "settings.color.lime",
  emerald: "settings.color.emerald",
  cyan: "settings.color.cyan",
  indigo: "settings.color.indigo",
  violet: "settings.color.violet",
  slate: "settings.color.slate",
} as const satisfies Record<CategoryColor, string>;
