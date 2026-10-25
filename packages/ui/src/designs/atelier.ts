import type { DesignDefinition } from "./types";

const SANS = '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif';
const SERIF = '"Instrument Serif", ui-serif, Georgia, serif';

/** Atelier (plan 15, picture 1): editorial. Ink and paper, Instrument Serif titles and italic section labels, avatars in rows. */
export const atelier: DesignDefinition = {
  id: "atelier",
  palette: { light: "atelier-light", dark: "atelier-dark" },
  vibrancy: false,
  fonts: { sans: SANS, display: SERIF, features: '"cv11", "ss01"' },
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
  tracking: { tight: "-0.006em", display: "-0.01em" },
  type: {
    listTitle: { family: "display", size: "1.875rem", leading: "1", weight: 400, strong: 400, tracking: "-0.005em", style: "normal" },
    greeting: { family: "display", size: "1.875rem", leading: "1", weight: 400, strong: 400, tracking: "-0.005em", style: "normal" },
    listSubtitle: { family: "sans", size: "0.75rem", leading: "1rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    sectionLabel: { family: "display", size: "1.0625rem", leading: "1.375rem", weight: 400, strong: 400, tracking: "0em", style: "italic" },
    nav: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowFrom: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 500, strong: 600, tracking: "0em", style: "normal" },
    rowSubject: { family: "sans", size: "0.8125rem", leading: "1.25rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowSnippet: { family: "sans", size: "0.8125rem", leading: "1.25rem", weight: 400, strong: 400, tracking: "0em", style: "normal" },
    readerSubject: { family: "display", size: "2.75rem", leading: "1.05", weight: 400, strong: 400, tracking: "-0.005em", style: "normal" },
    senderName: { family: "sans", size: "0.90625rem", leading: "1.375rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    body: { family: "sans", size: "0.9375rem", leading: "1.625", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    compose: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 500, strong: 600, tracking: "0em", style: "normal" },
  },
  icon: { stroke: 1.5, toolbar: 1.5 },
  layout: { sidebar: "240px", listMin: "340px", listMax: "390px", readerMax: "768px", readerPadX: "2.5rem", rowRadius: "0.75rem", navRadius: "0.625rem", navHeight: "2rem" },
  rows: { comfortable: 84, compact: 44 },
  avatar: { row: 36, rowCompact: 22, message: 40, collapsed: 28, senderCard: 0 },
  surfaces: { draft: "outline" },
  variants: {
    compose: "sidebar-outline",
    listHeader: "display",
    search: "field",
    quickFilters: "menu",
    row: "avatar",
    categoryReview: "inline-badge",
    readerHeader: "chips-display",
    replyAction: "icons",
  },
};
