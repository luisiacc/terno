/**
 * The print palette. Paper is paper whatever the app's theme, so the print
 * document (apps/web/src/lib/print.ts) has its own fixed inks; every text ink
 * holds WCAG AA on the white page (print.test.ts).
 */
export const PRINT_INK = {
  paper: "#ffffff",
  text: "#1d1d1f",
  /** header lines, labels' companions, the attachment list */
  secondary: "#626267",
  /** addresses, sizes, image descriptions, "not downloaded" */
  tertiary: "#6e6e73",
  quote: "#4f4f54",
  link: "#0b4f9e",
  rule: "#d2d2d7",
  ruleSoft: "#e5e5ea",
} as const;
