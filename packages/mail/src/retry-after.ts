import type { BoundedHttpHeader } from "./types";
import { HTTP_EVIDENCE_HEADER_LIMIT } from "./http-response-evidence";

export type HttpDateParts = Readonly<{
  form: "imf-fixdate" | "rfc850" | "asctime";
  year: Readonly<{ kind: "full" | "two-digit"; value: number }>;
  month: number; day: number; weekday: number;
  hour: number; minute: number; second: number;
}>;
export type RetryAfterDirective =
  | { readonly kind: "not-visible" }
  | { readonly kind: "too-long" }
  | { readonly kind: "invalid" }
  | { readonly kind: "delay-seconds"; readonly decimal: string }
  | { readonly kind: "http-date"; readonly parts: HttpDateParts };
type HttpDateResult =
  | { readonly kind: "not-visible" | "too-long" | "invalid" }
  | { readonly kind: "http-date"; readonly parts: HttpDateParts };

type NonDate = Exclude<RetryAfterDirective, { kind: "delay-seconds" | "http-date" }>;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LONG_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEKDAY_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];

function fieldValue(header: BoundedHttpHeader): string | NonDate {
  if (header.kind === "not-visible") return { kind: "not-visible" };
  if (header.kind === "too-long" || header.value.length > HTTP_EVIDENCE_HEADER_LIMIT) return { kind: "too-long" };
  const value = header.value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!value || /[^\x20-\x7e]/.test(value)) return { kind: "invalid" };
  return value;
}

function weekday(year: number, month: number, day: number): number {
  // A full Gregorian cycle avoids negative division for January/February of year zero.
  let y = year + 400;
  if (month < 3) y--;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + WEEKDAY_OFFSETS[month - 1]! + day) % 7;
}

function dateValue(value: string): HttpDateResult {
  // fieldValue rejected nonASCII before applying the explicit token-case leniency.
  const normalized = value.toLowerCase();
  let form: HttpDateParts["form"], year: number, month: number, day: number, dayOfWeek: number, hour: number, minute: number, second: number;
  const imf = /^([a-z]{3}), ([0-9]{2}) ([a-z]{3}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) gmt$/.exec(normalized);
  const rfc850 = imf ? null : /^([a-z]{6,9}), ([0-9]{2})-([a-z]{3})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) gmt$/.exec(normalized);
  const asctime = imf || rfc850 ? null : /^([a-z]{3}) ([a-z]{3}) ( [0-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(normalized);
  const dated = imf ?? rfc850;
  if (dated) {
    form = imf ? "imf-fixdate" : "rfc850";
    dayOfWeek = (imf ? DAYS : LONG_DAYS).indexOf(dated[1]!);
    day = Number(dated[2]); month = MONTHS.indexOf(dated[3]!) + 1; year = Number(dated[4]);
    hour = Number(dated[5]); minute = Number(dated[6]); second = Number(dated[7]);
  } else if (asctime) {
    form = "asctime";
    dayOfWeek = DAYS.indexOf(asctime[1]!); month = MONTHS.indexOf(asctime[2]!) + 1; day = Number(asctime[3]);
    hour = Number(asctime[4]); minute = Number(asctime[5]); second = Number(asctime[6]); year = Number(asctime[7]);
  } else return { kind: "invalid" };
  if (dayOfWeek < 0 || month < 1 || day < 1 || hour > 23 || minute > 59 || second > 60) return { kind: "invalid" };
  const leap = year % 4 === 0 && (form === "rfc850" || year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : MONTH_LENGTHS[month - 1]!;
  if (day > days || (form !== "rfc850" && weekday(year, month, day) !== dayOfWeek)) return { kind: "invalid" };
  const parts: HttpDateParts = Object.freeze({ form, year: Object.freeze({ kind: form === "rfc850" ? "two-digit" : "full", value: year }), month, day, weekday: dayOfWeek, hour, minute, second });
  return Object.freeze({ kind: "http-date", parts });
}

export function parseRetryAfter(header: BoundedHttpHeader): RetryAfterDirective {
  const value = fieldValue(header);
  if (typeof value !== "string") return value;
  if (/^[0-9]+$/.test(value)) return Object.freeze({ kind: "delay-seconds", decimal: value.replace(/^0+/, "") || "0" });
  return dateValue(value);
}

export function parseHttpDate(header: BoundedHttpHeader): HttpDateResult {
  const value = fieldValue(header);
  return typeof value === "string" ? dateValue(value) : value;
}
