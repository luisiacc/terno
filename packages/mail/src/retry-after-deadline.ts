import type { HttpResponseEvidence } from "./types";
import { parseHttpDate, parseRetryAfter, type HttpDateParts } from "./retry-after";

export type RetryMinimum =
  | { readonly kind: "none"; readonly reason: "not-visible" | "invalid" | "too-long" }
  | { readonly kind: "at"; readonly atMs: number; readonly basis: "delay" | "date-local" | "date-paired" }
  | { readonly kind: "hold"; readonly reason: "clock" | "range" | "calendar" | "leap-second" };

const EPOCH_LIMIT = 8640000000000000n;
const DAY_MS = 86400000;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
type Hold = Extract<RetryMinimum, { kind: "hold" }>;
type CalendarTuple = readonly [number, number, number, number, number, number, number];
type DateResolution = { readonly kind: "epoch"; readonly ms: bigint } | Hold;

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// March-based Gregorian cycles keep every calendar intermediate an exact integer.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear - 719468;
}

function anniversary(receipt: number): CalendarTuple {
  const days = Math.floor(receipt / DAY_MS);
  const time = receipt - days * DAY_MS;
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460)
    + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const marchMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * marchMonth + 2) / 5) + 1;
  const month = marchMonth + (marchMonth < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0) + 50;
  // Keep H as a tuple: the anniversary can lie beyond the epoch endpoint.
  return [year, month, month === 2 && day === 29 && !leap(year) ? 28 : day,
    Math.floor(time / 3600000), Math.floor(time / 60000) % 60,
    Math.floor(time / 1000) % 60, time % 1000];
}

function after(a: CalendarTuple, b: CalendarTuple): boolean {
  for (let i = 0; i < 7; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

function inRange(ms: bigint): boolean {
  return ms >= -EPOCH_LIMIT && ms <= EPOCH_LIMIT;
}

function hold(reason: Hold["reason"]): Hold {
  return Object.freeze({ kind: "hold", reason });
}

function resolveDate(parts: HttpDateParts, receipt: number): DateResolution {
  let year = parts.year.value;
  if (parts.year.kind === "two-digit") {
    const h = anniversary(receipt);
    year += 100 * Math.floor(h[0] / 100);
    // Select the century before validation; an older valid date cannot repair it.
    if (after([year, parts.month, parts.day, parts.hour, parts.minute, parts.second, 0], h)) year -= 100;
  }
  const monthDays = parts.month === 2 && leap(year) ? 29 : MONTH_LENGTHS[parts.month - 1]!;
  if (year < 1900 || parts.day > monthDays) return hold("calendar");
  const days = daysFromCivil(year, parts.month, parts.day);
  if (((days + 4) % 7 + 7) % 7 !== parts.weekday) return hold("calendar");
  if (parts.second === 60) return hold("leap-second");
  const ms = BigInt(days) * BigInt(DAY_MS)
    + BigInt(parts.hour * 3600000 + parts.minute * 60000 + parts.second * 1000);
  return inRange(ms) ? { kind: "epoch", ms } : hold("range");
}

function at(ms: bigint, basis: Extract<RetryMinimum, { kind: "at" }>["basis"]): RetryMinimum {
  return inRange(ms) ? Object.freeze({ kind: "at", atMs: Number(ms), basis }) : hold("range");
}

export function resolveRetryMinimum(
  e: Pick<HttpResponseEvidence, "received" | "retryAfter" | "serverDate">,
): RetryMinimum {
  const directive = parseRetryAfter(e.retryAfter);
  if (directive.kind !== "delay-seconds" && directive.kind !== "http-date") {
    return Object.freeze({ kind: "none", reason: directive.kind });
  }
  if (e.received.kind !== "wall" || !Number.isSafeInteger(e.received.wallMs)
    || Math.abs(e.received.wallMs) > Number(EPOCH_LIMIT)) return hold("clock");
  const receipt = BigInt(e.received.wallMs);
  if (directive.kind === "delay-seconds") return at(receipt + BigInt(directive.decimal) * 1000n, "delay");
  const retry = resolveDate(directive.parts, e.received.wallMs);
  if (retry.kind === "hold") return retry;
  const local = receipt > retry.ms ? receipt : retry.ms;
  const date = parseHttpDate(e.serverDate);
  if (date.kind !== "http-date") return at(local, "date-local");
  const server = resolveDate(date.parts, e.received.wallMs);
  if (server.kind !== "epoch") return at(local, "date-local");
  const delta = retry.ms > server.ms ? retry.ms - server.ms : 0n;
  const paired = receipt + delta;
  return at(paired > local ? paired : local, "date-paired");
}
