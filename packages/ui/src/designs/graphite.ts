import type { DesignDefinition, TypeRole, TypeSpec } from "./types";

/** SF on a Mac (the system's own, in its optical sizes); the bundled Geist where SF can't go (the web build elsewhere) */
const SF = '-apple-system, BlinkMacSystemFont, "Geist Variable", ui-sans-serif, system-ui, sans-serif';
const TRACKING = "-0.15px";

/** [size, leading, weight, strong]: the only sizes are 12, 13, 14 and 24 */
const role = (size: string, leading: string, weight: number, strong: number): TypeSpec => ({ family: "sans", size, leading, weight, strong, tracking: TRACKING, style: "normal" });

/**
 * Weights: grey text in regular and medium (400, 500); words in the ink half a step heavier (450, 550; plan 174, the
 * owner: black reads blacker beside the grey, as the reference's does). SF is variable, so the half steps draw as such.
 */
const INK = 450;
const INK_MEDIUM = 550;

const TYPE: Record<TypeRole, TypeSpec> = {
  listTitle: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  greeting: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  listSubtitle: role("0.75rem", "1rem", 400, 500),
  sectionLabel: role("0.75rem", "1rem", 400, 400),
  // grey at rest; the selected item is in the ink
  nav: role("0.8125rem", "1.25rem", 400, INK_MEDIUM),
  // plan 158: a read row's sender is its anchor at medium, so an unread one needs a step above it to stay the stronger
  // (plan 174: 20 px lines, so a row's three read as lines rather than a block)
  rowFrom: role("0.8125rem", "1.25rem", INK_MEDIUM, 650),
  rowSubject: role("0.8125rem", "1.25rem", INK, INK_MEDIUM),
  rowSnippet: role("0.8125rem", "1.25rem", 400, 400),
  readerSubject: role("1.5rem", "2rem", INK_MEDIUM, INK_MEDIUM),
  senderName: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  body: role("0.875rem", "1.6", INK, INK_MEDIUM),
  compose: role("0.875rem", "1.25rem", INK, INK_MEDIUM),
};

/**
 * Graphite (plan 137): a simple system. SF in regular and medium at -0.15px (the ink half a step heavier, plan 174); type at 12, 13, 14 and 24; #171717,
 * #5D5D5D and #A4A4A4; 8 px navigation, 16 px cards, pill buttons. White panes divided by hairlines, no avatars in rows,
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
  // plan 174: room around the three lines (12 px above and below), as Mail and Search Browser's sidebar have; compact stays the dense choice
  rows: { comfortable: 84, compact: 32, wide: 40, results: 76 },
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
  },
};
