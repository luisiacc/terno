import { DEFAULT_DESIGN, type DesignId } from "@terno/core";
import { DESIGNS } from "./index";
import { RADIUS_STEPS, TEXT_STEPS, TYPE_ROLES, type DesignDefinition, type TypeRole } from "./types";

export const GENERATED_HEADER = "/* Generated from packages/ui/src/designs/*.ts by `pnpm --filter @terno/ui gen:designs`. Do not edit. */";

/** listTitle → list-title */
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every CSS variable a design sets, in a stable order. */
export function designVars(d: DesignDefinition): [string, string][] {
  const out: [string, string][] = [
    ["--ds-font-sans", d.fonts.sans],
    ["--ds-font-display", d.fonts.display],
    ["--ds-font-features", d.fonts.features],
    ["--ds-weight-semibold", String(d.weights.semibold)],
    ["--ds-weight-bold", String(d.weights.bold)],
    ["--ds-text-control", d.controlText],
  ];
  for (const step of TEXT_STEPS) {
    const [size, leading] = d.text[step];
    out.push([`--ds-text-${step}`, size], [`--ds-text-${step}-leading`, leading]);
  }
  for (const step of RADIUS_STEPS) out.push([`--ds-radius-${step}`, d.radius[step]]);
  // shadcn's base radius (input groups compute from it)
  out.push(["--radius", d.radius.lg]);
  out.push(["--ds-tracking-tight", d.tracking.tight], ["--ds-tracking-display", d.tracking.display], ["--ds-tracking-base", d.tracking.base], ["--ds-tracking-wide", d.tracking.wide]);
  for (const role of TYPE_ROLES) {
    const t = d.type[role as TypeRole];
    const p = `--type-${kebab(role)}`;
    out.push(
      [`${p}-family`, t.family === "display" ? d.fonts.display : d.fonts.sans],
      [`${p}-size`, t.size],
      [`${p}-leading`, t.leading],
      [`${p}-weight`, String(t.weight)],
      [`${p}-strong`, String(t.strong)],
      [`${p}-tracking`, t.tracking],
      [`${p}-style`, t.style],
    );
  }
  out.push(
    ["--icon-stroke", String(d.icon.stroke)],
    ["--icon-stroke-toolbar", String(d.icon.toolbar)],
    ["--icon-nav", `${d.icon.nav}px`],
    ["--sidebar-w", d.layout.sidebar],
    ["--list-min", d.layout.listMin],
    ["--list-max", d.layout.listMax],
    ["--reader-min", `${d.layout.readerMin}px`],
    ["--reader-max", d.layout.readerMax],
    ["--reader-pad-x", d.layout.readerPadX],
    // plan 160: a reader-pane title's line sits under the chips where the subject does (a chips line, min-h-5, and its mb-1)
    ["--pane-title-lead", d.variants.readerHeader === "chips-display" ? "1.5rem" : "0px"],
    ["--row-radius", d.layout.rowRadius],
    ["--nav-radius", d.layout.navRadius],
    ["--nav-h", d.layout.navHeight],
    ["--sidebar-pad", d.layout.sidebarPad],
    ["--nav-section-gap", d.layout.navSectionGap],
    ["--nav-section-h", d.layout.navSectionHeight],
    ["--card-radius", d.layout.cardRadius],
    ["--command-radius", d.layout.commandRadius],
    // plan 137: the floor under a worded button's corners: max(floor, its radius), so "control" draws what it always did
    ["--cta-floor", d.surfaces.cta === "pill" ? "9999px" : "0px"],
    ["--card-bg", d.surfaces.card === "tint" ? "var(--tint)" : "transparent"],
    ["--card-ring", d.surfaces.card === "tint" ? "transparent" : "var(--border)"],
    // plan 161: in a dialog in dark, a tint card is a step off the popover at most: it's ringed there
    ["--card-ring-dialog", d.surfaces.card === "tint" ? "var(--card-edge)" : "var(--border)"],
    ["--row-h", `${d.rows.comfortable}px`],
    ["--row-h-compact", `${d.rows.compact}px`],
    ["--avatar-row", `${d.avatar.row}px`],
    ["--avatar-row-compact", `${d.avatar.rowCompact}px`],
    ["--avatar-row-wide", `${d.avatar.rowWide}px`],
    ["--avatar-message", `${d.avatar.message}px`],
    ["--avatar-collapsed", `${d.avatar.collapsed}px`],
    ["--avatar-sender", `${d.avatar.senderCard}px`],
    // token references only: the colors stay the palette's (and their pairs are in CONTRAST_PAIRS)
    ["--draft-bg", d.surfaces.draft === "tint" ? "var(--tint)" : d.surfaces.draft === "outline" ? "var(--background)" : "var(--card)"],
    // plan 160: the palette's draft-edge, a composer's ring and dividers at the hairline floor (contrast.ts BOUNDARY_STEPS)
    ["--draft-ring", "var(--draft-edge)"],
    // plan 16: the composer's format bar, a quieter strip of the draft's own surface
    // (a mix of the ink, not --tint: in dark, tint and card are the same color and the well is gone)
    ["--format-bg", d.surfaces.draft === "outline" ? "transparent" : "color-mix(in oklab, var(--foreground) 4.5%, transparent)"],
    ["--format-ring", d.surfaces.draft === "outline" ? "0 0 0 var(--hairline-w) var(--border)" : "none"],
    ["--draft-shadow", d.surfaces.draft === "card" ? "0 1px 2px color-mix(in oklab, var(--shadow-color) 40%, transparent), 0 8px 24px -12px var(--shadow-color)" : "0 0 transparent"],
  );
  return out;
}

function block(d: DesignDefinition, selector: string): string {
  return `${selector} {\n${designVars(d)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;
}

/**
 * One `[data-design="id"]` block per design. Attribute selectors (not
 * `:root[…]`) so a Settings preview can nest any design; `:root` takes the
 * fallback design's values before theme.js has run.
 */
export function generateDesignsCss(designs: readonly DesignDefinition[] = DESIGNS, fallback: DesignId = DEFAULT_DESIGN): string {
  const first = designs.find((d) => d.id === fallback) ?? designs[0];
  if (!first) return `${GENERATED_HEADER}\n`;
  const rest = designs.filter((d) => d !== first);
  return [GENERATED_HEADER, block(first, `:root,\n[data-design="${first.id}"]`), ...rest.map((d) => block(d, `[data-design="${d.id}"]`))].join("\n\n") + "\n";
}

/**
 * The `type-<role>` and `type-<role>-strong` utilities, one pair per role:
 * they read the role variables every design block sets.
 */
export function generateTypeRolesCss(): string {
  const blocks = TYPE_ROLES.flatMap((role) => {
    const p = `--type-${kebab(role)}`;
    const body = (weight: string) =>
      [`  font-family: var(${p}-family);`, `  font-size: var(${p}-size);`, `  line-height: var(${p}-leading);`, `  font-weight: var(${p}-${weight});`, `  letter-spacing: var(${p}-tracking);`, `  font-style: var(${p}-style);`].join("\n");
    return [`@utility type-${kebab(role)} {\n${body("weight")}\n}`, `@utility type-${kebab(role)}-strong {\n${body("strong")}\n}`];
  });
  return [GENERATED_HEADER, ...blocks].join("\n\n") + "\n";
}
