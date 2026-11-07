import type { DesignDefinition, TypeRole, TypeSpec } from "./types";

/** SF on a Mac (the system's own, in its optical sizes); the bundled Geist where SF can't go (the web build elsewhere) */
const SF = '-apple-system, BlinkMacSystemFont, "Geist Variable", ui-sans-serif, system-ui, sans-serif';
const TRACKING = "-0.15px";

/** [size, leading, weight, strong]: the only sizes are 12, 13, 14 and 24, the only weights 400 and 500 */
const role = (size: string, leading: string, weight: 400 | 500, strong: 400 | 500): TypeSpec => ({ family: "sans", size, leading, weight, strong, tracking: TRACKING, style: "normal" });

const TYPE: Record<TypeRole, TypeSpec> = {
  listTitle: role("0.875rem", "1.25rem", 500, 500),
  greeting: role("0.875rem", "1.25rem", 500, 500),
  listSubtitle: role("0.75rem", "1rem", 400, 500),
  sectionLabel: role("0.75rem", "1rem", 400, 400),
  nav: role("0.8125rem", "1.25rem", 400, 500),
  rowFrom: role("0.8125rem", "1.125rem", 400, 500),
  rowSubject: role("0.8125rem", "1.125rem", 400, 500),
  rowSnippet: role("0.8125rem", "1.125rem", 400, 400),
  readerSubject: role("1.5rem", "2rem", 500, 500),
  senderName: role("0.875rem", "1.25rem", 500, 500),
  body: role("0.875rem", "1.6", 400, 500),
  compose: role("0.875rem", "1.25rem", 400, 500),
};

/**
 * Graphite (plan 137): a simple system. SF in regular and medium at -0.15px; type at 12, 13, 14 and 24; #292929,
 * #5D5D5D and #9E9E9E; 8 px navigation, 16 px cards, pill buttons. White panes divided by hairlines, no avatars in rows,
 * and "New message" as a plain row, so the only filled pills are real calls to action.
 */
export const graphite: DesignDefinition = {
  id: "graphite",
  palette: { light: "graphite-light", dark: "graphite-dark" },
  vibrancy: false,
  fonts: { sans: SF, display: SF, features: '"kern"', faces: [] },
  weights: { semibold: 500, bold: 500 },
  controlText: "0.8125rem",
  // 12 · 12 · 13 · 14 · 14 · 14 · 24
  text: {
    "2xs": ["0.75rem", "1rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.8125rem", "1.125rem"],
    base: ["0.875rem", "1.25rem"],
    md: ["0.875rem", "1.25rem"],
    lg: ["0.875rem", "1.25rem"],
    xl: ["1.5rem", "2rem"],
  },
  // 4 badges · 8 navigation, rows, fields, menu and palette rows · 16 cards, drafts, toasts, the palette
  radius: { sm: "0.25rem", md: "0.5rem", lg: "0.5rem", xl: "1rem", "2xl": "1rem", "3xl": "1rem", "4xl": "1rem" },
  tracking: { tight: TRACKING, display: TRACKING, base: TRACKING, wide: TRACKING },
  type: TYPE,
  icon: { stroke: 1.5, toolbar: 1.5, nav: 14 },
  layout: { sidebar: "216px", listMin: "340px", listMax: "min(400px, 32vw)", readerMin: 348, readerMax: "704px", readerPadX: "2rem", rowRadius: "0.5rem", navRadius: "0.5rem", navHeight: "1.75rem", sidebarPad: "0.75rem", navSectionGap: "1.25rem", navSectionHeight: "1.625rem", cardRadius: "1rem", commandRadius: "0.5rem" },
  rows: { comfortable: 64, compact: 32, wide: 36, results: 64 },
  avatar: { row: 0, rowCompact: 0, rowWide: 0, message: 28, collapsed: 28, senderCard: 0 },
  surfaces: { draft: "outline", inboxCount: "muted", cta: "pill", card: "outline" },
  variants: {
    compose: "sidebar-row",
    listHeader: "title",
    search: "field",
    quickFilters: "menu",
    row: "classic",
    readerHeader: "classic",
    replyAction: "control",
    categoryTabs: "pill",
  },
};
