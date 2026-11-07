import type { DesignDefinition } from "./types";

const SANS = '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif';

/** Atelier (plan 15, picture 1): editorial. Ink and paper, Instrument Sans throughout, upright and plain, avatars in rows. */
export const atelier: DesignDefinition = {
  id: "atelier",
  palette: { light: "atelier-light", dark: "atelier-dark" },
  vibrancy: false,
  fonts: { sans: SANS, display: SANS, features: '"cv11", "ss01"', faces: ['400 1em "Instrument Sans Variable"', '600 1em "Instrument Sans Variable"'] },

  weights: { semibold: 600, bold: 700 },
  controlText: "0.8rem",
  text: {
    "2xs": ["0.6875rem", "0.875rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.84375rem", "1.25rem"],
    base: ["0.90625rem", "1.375rem"],
    md: ["0.9375rem", "1.375rem"],
    lg: ["1.0625rem", "1.5rem"],
    xl: ["1.375rem", "1.75rem"],
  },
  radius: { sm: "0.3125rem", md: "0.5rem", lg: "0.625rem", xl: "0.75rem", "2xl": "0.875rem", "3xl": "1.125rem", "4xl": "1.375rem" },
  tracking: { tight: "-0.006em", display: "-0.01em", base: "normal", wide: "0.025em" },
  type: {
    listTitle: { family: "display", size: "1.375rem", leading: "1.75rem", weight: 600, strong: 600, tracking: "-0.02em", style: "normal" },
    greeting: { family: "display", size: "1.375rem", leading: "1.75rem", weight: 600, strong: 600, tracking: "-0.02em", style: "normal" },
    listSubtitle: { family: "sans", size: "0.75rem", leading: "1rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    sectionLabel: { family: "sans", size: "0.75rem", leading: "1rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    nav: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowFrom: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    rowSubject: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowSnippet: { family: "sans", size: "0.78125rem", leading: "1.125rem", weight: 400, strong: 400, tracking: "0em", style: "normal" },
    readerSubject: { family: "display", size: "2rem", leading: "1.15", weight: 600, strong: 600, tracking: "-0.02em", style: "normal" },
    senderName: { family: "sans", size: "0.90625rem", leading: "1.375rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    body: { family: "sans", size: "0.9375rem", leading: "1.625", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    compose: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 500, strong: 600, tracking: "0em", style: "normal" },
  },
  icon: { stroke: 1.5, toolbar: 1.5, nav: 16 },
  layout: { sidebar: "240px", listMin: "340px", listMax: "min(390px, 32vw)", readerMin: 380, readerMax: "704px", readerPadX: "2rem", rowRadius: "0.75rem", navRadius: "0.625rem", navHeight: "2rem", sidebarPad: "0.5rem", navSectionGap: "1rem", navSectionHeight: "1.25rem", cardRadius: "calc(var(--ds-radius-lg) + 2px)", commandRadius: "var(--ds-radius-xl)" },
  rows: { comfortable: 72, compact: 44, wide: 48, results: 72 },
  avatar: { row: 32, rowCompact: 22, rowWide: 24, message: 28, collapsed: 28, senderCard: 0 },
  surfaces: { draft: "outline", inboxCount: "muted", cta: "control", card: "tint" },
  variants: {
    compose: "sidebar-outline",
    listHeader: "display",
    search: "field",
    quickFilters: "menu",
    row: "avatar",
    readerHeader: "chips-display",
    replyAction: "control",
    categoryTabs: "underline",
  },
};
