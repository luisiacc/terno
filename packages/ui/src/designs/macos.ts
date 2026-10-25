import type { DesignDefinition } from "./types";

const SF = '-apple-system, BlinkMacSystemFont, "Geist Variable", ui-sans-serif, system-ui, sans-serif';

/** macOS: the app as it was before designs (plans 01, 07): Apple Mail-like, dense, SF. */
export const macos: DesignDefinition = {
  id: "macos",
  palette: { light: "terno-light", dark: "terno-dark" },
  vibrancy: true,
  fonts: { sans: SF, display: SF, features: '"cv11", "ss01"', faces: [] },
  // 11 · 12 · 13 · 14 · 15 · 17 · 20
  text: {
    "2xs": ["0.6875rem", "0.875rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.8125rem", "1.125rem"],
    base: ["0.875rem", "1.375rem"],
    md: ["0.9375rem", "1.25rem"],
    lg: ["1.0625rem", "1.375rem"],
    xl: ["1.25rem", "1.625rem"],
  },
  // 4 · 6 controls and rows · 8 menus and tiles · 12 draft and toasts · 16 dialogs and palette
  radius: { sm: "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.1rem", "4xl": "1.3rem" },
  tracking: { tight: "-0.011em", display: "-0.018em" },
  type: {
    listTitle: { family: "sans", size: "0.9375rem", leading: "1.25rem", weight: 600, strong: 600, tracking: "-0.011em", style: "normal" },
    greeting: { family: "sans", size: "0.9375rem", leading: "1.25rem", weight: 600, strong: 600, tracking: "-0.011em", style: "normal" },
    listSubtitle: { family: "sans", size: "0.6875rem", leading: "1.25", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    sectionLabel: { family: "sans", size: "0.6875rem", leading: "0.875rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    nav: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowFrom: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    rowSubject: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 500, tracking: "0em", style: "normal" },
    rowSnippet: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 400, strong: 400, tracking: "0em", style: "normal" },
    readerSubject: { family: "sans", size: "1.25rem", leading: "1.625rem", weight: 600, strong: 600, tracking: "-0.018em", style: "normal" },
    senderName: { family: "sans", size: "0.875rem", leading: "1.375rem", weight: 600, strong: 600, tracking: "0em", style: "normal" },
    body: { family: "sans", size: "0.875rem", leading: "1.625", weight: 400, strong: 600, tracking: "0em", style: "normal" },
    compose: { family: "sans", size: "0.8125rem", leading: "1.125rem", weight: 500, strong: 600, tracking: "0em", style: "normal" },
  },
  icon: { stroke: 2, toolbar: 1.75 },
  layout: { sidebar: "232px", listMin: "340px", listMax: "400px", readerMax: "860px", readerPadX: "1.75rem", rowRadius: "0.375rem", navRadius: "0.375rem", navHeight: "1.75rem" },
  rows: { comfortable: 68, compact: 40 },
  avatar: { row: 0, rowCompact: 0, message: 36, collapsed: 24, senderCard: 0 },
  surfaces: { draft: "tint" },
  variants: {
    compose: "list-header",
    listHeader: "title",
    search: "field",
    quickFilters: "menu",
    row: "classic",
    categoryReview: "sub-rows",
    readerHeader: "classic",
    replyAction: "icons",
  },
};
