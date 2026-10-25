import type { DesignDefinition } from "./types";

const FIGTREE = '"Figtree Variable", ui-sans-serif, system-ui, sans-serif';

/** Lumen (plan 15, picture 2; the default): warm and people-first. Figtree, big avatars, a greeting, filter chips, soft round shapes. */
export const lumen: DesignDefinition = {
  id: "lumen",
  palette: { light: "lumen-light", dark: "lumen-dark" },
  vibrancy: false,
  fonts: { sans: FIGTREE, display: FIGTREE, features: '"cv11", "ss01"', faces: ['400 1em "Figtree Variable"', '600 1em "Figtree Variable"', '700 1em "Figtree Variable"'] },
  text: {
    "2xs": ["0.6875rem", "0.875rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.84375rem", "1.25rem"],
    base: ["0.9375rem", "1.5rem"],
    md: ["1rem", "1.375rem"],
    lg: ["1.125rem", "1.5rem"],
    xl: ["1.5rem", "1.875rem"],
  },
  radius: { sm: "0.375rem", md: "0.625rem", lg: "0.75rem", xl: "1rem", "2xl": "1.25rem", "3xl": "1.5rem", "4xl": "1.75rem" },
  tracking: { tight: "-0.012em", display: "-0.022em" },
  type: {
    listTitle: { family: "display", size: "1.5rem", leading: "1.875rem", weight: 700, strong: 700, tracking: "-0.02em", style: "normal" },
    greeting: { family: "display", size: "1.5rem", leading: "1.875rem", weight: 700, strong: 700, tracking: "-0.02em", style: "normal" },
    listSubtitle: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    sectionLabel: { family: "sans", size: "0.75rem", leading: "1rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    nav: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    rowFrom: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 600, strong: 700, tracking: "0em", style: "normal" },
    rowSubject: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowSnippet: { family: "sans", size: "0.78125rem", leading: "1.125rem", weight: 400, strong: 400, tracking: "0em", style: "normal" },
    readerSubject: { family: "display", size: "2rem", leading: "1.15", weight: 700, strong: 700, tracking: "-0.025em", style: "normal" },
    senderName: { family: "sans", size: "1.0625rem", leading: "1.375rem", weight: 700, strong: 700, tracking: "-0.005em", style: "normal" },
    body: { family: "sans", size: "0.96875rem", leading: "1.65", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    compose: { family: "sans", size: "0.84375rem", leading: "1.25rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
  },
  icon: { stroke: 1.5, toolbar: 1.5 },
  layout: { sidebar: "248px", listMin: "340px", listMax: "min(400px, 32vw)", readerMax: "760px", readerPadX: "2.5rem", rowRadius: "1rem", navRadius: "0.75rem", navHeight: "2.125rem" },
  rows: { comfortable: 84, compact: 48 },
  avatar: { row: 44, rowCompact: 24, message: 32, collapsed: 32, senderCard: 64 },
  surfaces: { draft: "card", reviewBadge: "tinted", inboxCount: "unread" },
  variants: {
    compose: "sidebar-pill",
    listHeader: "greeting",
    search: "button",
    quickFilters: "chips",
    row: "large-avatar",
    categoryReview: "inline-badge",
    readerHeader: "sender-card",
    replyAction: "pill",
  },
};
