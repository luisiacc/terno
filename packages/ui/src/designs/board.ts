import type { DesignDefinition } from "./types";

const INTER = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';

/**
 * Board (plan 117): BoardUI's base components (boardui.com, MIT) as a design. Inter at BoardUI's ramp
 * (body 14/20, body 2 13/18, caption 12/16), its 10 px controls and 16 px menus, medium weights, small avatars.
 * Its controls are every design's since plan 118; Board is them in BoardUI's own type, shapes and colors.
 */
export const board: DesignDefinition = {
  id: "board",
  palette: { light: "board-light", dark: "board-dark" },
  vibrancy: false,
  // Inter as BoardUI sets it: no stylistic sets (the others' cv11 would give Inter a single-storey a)
  fonts: { sans: INTER, display: INTER, features: '"kern"', faces: ['400 1em "Inter Variable"', '500 1em "Inter Variable"', '600 1em "Inter Variable"'] },
  // 11 · 12 · 13 · 14 · 16 · 18 · 24 (caption 2, caption 1, body 2, body, headline, title 3, title 1)
  text: {
    "2xs": ["0.6875rem", "0.9375rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.8125rem", "1.125rem"],
    base: ["0.875rem", "1.25rem"],
    md: ["1rem", "1.375rem"],
    lg: ["1.125rem", "1.5rem"],
    xl: ["1.5rem", "2.125rem"],
  },
  // 4 badges and checkboxes · 8 menu rows · 10 buttons and fields · 12 · 16 menus · 24 cards
  radius: { sm: "0.25rem", md: "0.5rem", lg: "0.625rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", "4xl": "1.75rem" },
  tracking: { tight: "-0.006em", display: "-0.02em" },
  type: {
    listTitle: { family: "display", size: "1.25rem", leading: "1.625rem", weight: 600, strong: 600, tracking: "-0.017em", style: "normal" },
    greeting: { family: "display", size: "1.25rem", leading: "1.625rem", weight: 600, strong: 600, tracking: "-0.017em", style: "normal" },
    listSubtitle: { family: "sans", size: "0.75rem", leading: "1rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    sectionLabel: { family: "sans", size: "0.75rem", leading: "1rem", weight: 500, strong: 500, tracking: "0.01em", style: "normal" },
    nav: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 400, strong: 500, tracking: "-0.006em", style: "normal" },
    rowFrom: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 500, strong: 600, tracking: "-0.006em", style: "normal" },
    rowSubject: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowSnippet: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 400, tracking: "0em", style: "normal" },
    readerSubject: { family: "display", size: "1.5rem", leading: "2rem", weight: 600, strong: 600, tracking: "-0.02em", style: "normal" },
    senderName: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 600, strong: 600, tracking: "-0.006em", style: "normal" },
    body: { family: "sans", size: "0.875rem", leading: "1.6", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    compose: { family: "sans", size: "0.875rem", leading: "1.25rem", weight: 500, strong: 600, tracking: "-0.006em", style: "normal" },
  },
  icon: { stroke: 1.5, toolbar: 1.5 },
  layout: { sidebar: "240px", listMin: "340px", listMax: "min(400px, 32vw)", readerMin: 360, readerMax: "800px", readerPadX: "2rem", rowRadius: "0.625rem", navRadius: "0.5rem", navHeight: "2rem" },
  rows: { comfortable: 76, compact: 44, wide: 48 },
  avatar: { row: 32, rowCompact: 20, rowWide: 24, message: 32, collapsed: 24, senderCard: 0 },
  surfaces: { draft: "outline", reviewBadge: "tinted", inboxCount: "muted" },
  variants: {
    compose: "sidebar-pill",
    listHeader: "title",
    search: "field",
    quickFilters: "menu",
    row: "avatar",
    categoryReview: "inline-badge",
    readerHeader: "classic",
    replyAction: "icons",
    categoryTabs: "pill",
  },
};
