/**
 * Amounts, dates and times as people write them in English and Spanish: what the writing checks compare (plan 133 §6.7)
 * and what makes a machine's short lines worth reading (plan 269). Case-insensitive; dates match text without accents.
 */

export const MONTHS: Record<string, number> = {
  january: 1, jan: 1, enero: 1, ene: 1,
  february: 2, feb: 2, febrero: 2,
  march: 3, mar: 3, marzo: 3,
  april: 4, apr: 4, abril: 4, abr: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, junio: 6,
  july: 7, jul: 7, julio: 7,
  august: 8, aug: 8, agosto: 8, ago: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9,
  october: 10, oct: 10, octubre: 10,
  november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12, dic: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const CURRENCY = "[$€£]|usd|eur|gbp|mxn|euros?|dollars?|d[oó]lares|pesos?";
export const AMOUNT = new RegExp(`(?:(?:${CURRENCY})\\s?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:${CURRENCY})(?![\\p{L}]))`, "giu");
export const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:de\\s+|of\\s+)?)(${MONTH_RE})\\b\\.?`, "giu");
export const MONTH_DAY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "giu");
export const NUMERIC_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
/** 06/03/2026, 3.6.26: day and month in either order */
export const SLASH_DATE = /\b\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})\b/g;
/** 14:30, 6 pm, 6:30 p.m. */
export const TIME = /\b\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?(?![\p{L}\p{N}])|\b\d{1,2}\s?[ap]\.?m\.?(?![\p{L}\p{N}])/giu;
