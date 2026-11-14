import type { DesignDefinition, TypeRole, TypeSpec } from "./types";

/** SF on a Mac (the system's own, in its optical sizes); the bundled Geist where SF can't go (the web build elsewhere) */
const SF = '-apple-system, BlinkMacSystemFont, "Geist Variable", ui-sans-serif, system-ui, sans-serif';
const TRACKING = "-0.15px";

const role = (size: string, leading: string, weight: number, strong: number): TypeSpec => ({ family: "sans", size, leading, weight, strong, tracking: TRACKING, style: "normal" });

/** Graphite's half steps: words in the ink a little heavier than the grey beside them */
const INK = 450;
const INK_MEDIUM = 550;
const UNREAD = 650;

const TYPE: Record<TypeRole, TypeSpec> = {
  listTitle: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  greeting: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  listSubtitle: role("0.75rem", "1rem", 400, 500),
  sectionLabel: role("0.75rem", "1rem", 400, 400),
  nav: role("0.8125rem", "1.25rem", 400, INK_MEDIUM),
  // after relief-r03 (the owner): read and unread apart by more than a half step, the dot kept: a read row at regular
  // weight (and in the softer ink, surfaces.readRow), an unread one's sender and subject one heavy block
  rowFrom: role("0.8125rem", "1.25rem", 500, UNREAD),
  rowSubject: role("0.8125rem", "1.25rem", 400, UNREAD),
  rowSnippet: role("0.8125rem", "1.25rem", 400, 400),
  readerSubject: role("1.5rem", "2rem", INK_MEDIUM, INK_MEDIUM),
  senderName: role("0.875rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
  body: role("0.875rem", "1.6", INK, INK_MEDIUM),
  compose: role("0.8125rem", "1.25rem", INK_MEDIUM, INK_MEDIUM),
};

/**
 * Relief (plan 204): the owner's two reference widgets. Pale grey surfaces; controls that stand up from them (pills ringed
 * in a dark rim with a white one inside, lit along the top edge) or sink into them (tracks shaded at the top); the ink
 * for what's on or primary. Graphite's type and structure, with the pictures' rounder shapes: pill buttons and
 * navigation, 18 px cards, and New message as the pictures' black pill.
 */
export const relief: DesignDefinition = {
  id: "relief",
  palette: { light: "relief-light", dark: "relief-dark" },
  vibrancy: false,
  fonts: { sans: SF, display: SF, features: '"kern"', faces: [] },
  weights: { semibold: 550, bold: 600 },
  controlText: "0.8125rem",
  text: {
    "2xs": ["0.75rem", "1rem"],
    xs: ["0.75rem", "1rem"],
    sm: ["0.8125rem", "1.125rem"],
    base: ["0.875rem", "1.25rem"],
    md: ["0.875rem", "1.25rem"],
    lg: ["0.9375rem", "1.375rem"],
    xl: ["1.5rem", "2rem"],
  },
  // 6 badges · 10 rows, fields, menu and palette rows · 18 cards, drafts, toasts, the palette, dialogs
  radius: { sm: "0.375rem", md: "0.625rem", lg: "0.625rem", xl: "1.125rem", "2xl": "1.125rem", "3xl": "1.375rem", "4xl": "1.375rem" },
  tracking: { tight: TRACKING, display: TRACKING, base: TRACKING, wide: TRACKING },
  type: TYPE,
  icon: { stroke: 1.5, toolbar: 1.5, nav: 14 },
  layout: { sidebar: "216px", listMin: "340px", listMax: "min(400px, 32vw)", readerMin: 348, readerMax: "704px", readerPadX: "2rem", rowRadius: "0.625rem", navRadius: "9999px", navHeight: "1.75rem", sidebarPad: "0.75rem", navSectionGap: "1.25rem", navSectionHeight: "1.625rem", cardRadius: "1.125rem", commandRadius: "0.625rem" },
  rows: { comfortable: 84, compact: 32, wide: 40, results: 76 },
  avatar: { row: 0, rowCompact: 0, rowWide: 0, message: 28, collapsed: 28, senderCard: 0 },
  surfaces: { draft: "card", inboxCount: "muted", cta: "pill", card: "raised", depth: "relief", readRow: "soft" },
  variants: {
    compose: "sidebar-pill",
    listHeader: "title",
    search: "field",
    quickFilters: "menu",
    row: "classic",
    readerHeader: "classic",
    replyAction: "pill",
  },
};
