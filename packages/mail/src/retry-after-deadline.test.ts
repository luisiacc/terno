import { describe, expect, it, vi } from "vitest";
import { resolveRetryMinimum, type RetryMinimum } from "./retry-after-deadline";
import type { BoundedHttpHeader, HttpReceipt, HttpResponseEvidence } from "./types";

type Input = Pick<HttpResponseEvidence, "received" | "retryAfter" | "serverDate">;
type Header = string | BoundedHttpHeader;
interface Case {
  name: string;
  receipt: number | HttpReceipt;
  retryAfter: Header;
  serverDate?: Header;
  expected: RetryMinimum;
}

const absent: BoundedHttpHeader = Object.freeze({ kind: "not-visible" });
const tooLong: BoundedHttpHeader = Object.freeze({ kind: "too-long" });
const invalidReceipt: HttpReceipt = Object.freeze({ source: "date-now", kind: "invalid" });
const header = (value: Header): BoundedHttpHeader =>
  Object.freeze(typeof value === "string" ? { kind: "value", value } : { ...value });
const input = (receipt: number | HttpReceipt, retryAfter: Header, serverDate: Header = absent): Input =>
  Object.freeze({
    received: Object.freeze(typeof receipt === "number" ? { source: "date-now", kind: "wall", wallMs: receipt } : { ...receipt }),
    retryAfter: header(retryAfter),
    serverDate: header(serverDate),
  });

const cases: readonly Case[] = [
  { name: "01 numeric delay 120s at Unix origin", receipt: 0, retryAfter: "120", expected: { kind: "at", atMs: 120000, basis: "delay" } },
  { name: "02 absent directive", receipt: 0, retryAfter: absent, expected: { kind: "none", reason: "not-visible" } },
  { name: "03 explicit overlong directive", receipt: 0, retryAfter: tooLong, expected: { kind: "none", reason: "too-long" } },
  { name: "04 bounds original value before trimming", receipt: 0, retryAfter: " " + "1".repeat(255) + "\t", expected: { kind: "none", reason: "too-long" } },
  { name: "05 empty directive", receipt: 0, retryAfter: "", expected: { kind: "none", reason: "invalid" } },
  { name: "06 combined directive", receipt: 0, retryAfter: "1, 2", expected: { kind: "none", reason: "invalid" } },
  { name: "07 negative directive", receipt: 0, retryAfter: "-1", expected: { kind: "none", reason: "invalid" } },
  { name: "08 fractional directive", receipt: 0, retryAfter: "1.5", expected: { kind: "none", reason: "invalid" } },
  { name: "09 exponent directive", receipt: 0, retryAfter: "1e3", expected: { kind: "none", reason: "invalid" } },
  { name: "10 Unicode digits", receipt: 0, retryAfter: "１２", expected: { kind: "none", reason: "invalid" } },
  { name: "11 trailing CRLF", receipt: 0, retryAfter: "120\r\n", expected: { kind: "none", reason: "invalid" } },
  { name: "12 full-year wrong weekday remains parser invalid", receipt: 0, retryAfter: "Mon, 01 Jan 2000 00:00:00 GMT", expected: { kind: "none", reason: "invalid" } },
  { name: "13 impossible full-year 1900 leap day", receipt: 0, retryAfter: "Thu, 29 Feb 1900 00:00:00 GMT", expected: { kind: "none", reason: "invalid" } },
  { name: "14 impossible full-year 2100 leap day", receipt: 0, retryAfter: "Mon, 29 Feb 2100 00:00:00 GMT", expected: { kind: "none", reason: "invalid" } },
  { name: "15 second61 is parser invalid", receipt: 0, retryAfter: "Sat, 01 Jan 2000 00:00:61 GMT", expected: { kind: "none", reason: "invalid" } },
  { name: "16 absent wins over invalid receipt", receipt: invalidReceipt, retryAfter: absent, expected: { kind: "none", reason: "not-visible" } },
  { name: "17 malformed wins over invalid receipt", receipt: invalidReceipt, retryAfter: "bad", expected: { kind: "none", reason: "invalid" } },
  { name: "18 overlong wins over invalid receipt", receipt: invalidReceipt, retryAfter: tooLong, expected: { kind: "none", reason: "too-long" } },
  { name: "19 parser calendar failure wins over invalid receipt", receipt: invalidReceipt, retryAfter: "Mon, 01 Jan 2000 00:00:00 GMT", expected: { kind: "none", reason: "invalid" } },
  { name: "20 valid decimal with explicit invalid receipt", receipt: invalidReceipt, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "21 valid date with explicit invalid receipt", receipt: invalidReceipt, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "hold", reason: "clock" } },
  { name: "22 NaN wall receipt", receipt: NaN, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "23 positive infinite wall receipt", receipt: Infinity, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "24 negative infinite wall receipt", receipt: -Infinity, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "25 fractional wall receipt", receipt: 0.5, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "26 safe integer beyond positive epoch domain", receipt: 8640000000000001, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "27 safe integer beyond negative epoch domain", receipt: -8640000000000001, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "28 maximum safe integer is not a valid wall epoch", receipt: Number.MAX_SAFE_INTEGER, retryAfter: "120", expected: { kind: "hold", reason: "clock" } },
  { name: "29 clock precedes huge decimal range", receipt: invalidReceipt, retryAfter: "9".repeat(256), expected: { kind: "hold", reason: "clock" } },
  { name: "30 clock precedes pre1900 calendar", receipt: invalidReceipt, retryAfter: "Sun, 31 Dec 1899 00:00:00 GMT", expected: { kind: "hold", reason: "clock" } },
  { name: "31 clock precedes leap second", receipt: invalidReceipt, retryAfter: "Tue, 29 Feb 2000 23:59:60 GMT", expected: { kind: "hold", reason: "clock" } },
  { name: "32 clock precedes unresolved RFC850 weekday", receipt: invalidReceipt, retryAfter: "Monday, 01-Jan-00 00:00:00 GMT", expected: { kind: "hold", reason: "clock" } },
  { name: "33 zero delay", receipt: 0, retryAfter: "0", expected: { kind: "at", atMs: 0, basis: "delay" } },
  { name: "34 all-zero directive", receipt: 123, retryAfter: "0000", expected: { kind: "at", atMs: 123, basis: "delay" } },
  { name: "35 leading zeros preserve seconds", receipt: 123, retryAfter: "000120", expected: { kind: "at", atMs: 120123, basis: "delay" } },
  { name: "36 ASCII outer space and tab", receipt: 123, retryAfter: " \t00120\t ", expected: { kind: "at", atMs: 120123, basis: "delay" } },
  { name: "37 negative receipt fractional second position", receipt: -1, retryAfter: "1", expected: { kind: "at", atMs: 999, basis: "delay" } },
  { name: "38 retain receipt milliseconds", receipt: 123, retryAfter: "120", expected: { kind: "at", atMs: 120123, basis: "delay" } },
  { name: "39 maximum decimal epoch from zero", receipt: 0, retryAfter: "8640000000000", expected: { kind: "at", atMs: 8640000000000000, basis: "delay" } },
  { name: "40 one second above domain", receipt: 0, retryAfter: "8640000000001", expected: { kind: "hold", reason: "range" } },
  { name: "41 exact upper boundary with one second", receipt: 8639999999999000, retryAfter: "1", expected: { kind: "at", atMs: 8640000000000000, basis: "delay" } },
  { name: "42 one millisecond above upper boundary", receipt: 8639999999999001, retryAfter: "1", expected: { kind: "hold", reason: "range" } },
  { name: "43 exact cancellation through unsafe Number intermediate", receipt: -8640000000000000, retryAfter: "17280000000000", expected: { kind: "at", atMs: 8640000000000000, basis: "delay" } },
  { name: "44 lowest wall plus zero", receipt: -8640000000000000, retryAfter: "0", expected: { kind: "at", atMs: -8640000000000000, basis: "delay" } },
  { name: "45 highest wall plus zero", receipt: 8640000000000000, retryAfter: "0", expected: { kind: "at", atMs: 8640000000000000, basis: "delay" } },
  { name: "46 negative zero normalizes as zero instant", receipt: -0, retryAfter: "0", expected: { kind: "at", atMs: 0, basis: "delay" } },
  { name: "47 256 zero digits remain representable", receipt: 123, retryAfter: "0".repeat(256), expected: { kind: "at", atMs: 123, basis: "delay" } },
  { name: "48 256 nonzero digits hold", receipt: 0, retryAfter: "9".repeat(256), expected: { kind: "hold", reason: "range" } },
  { name: "49 decimal at 2^53 seconds cannot be clamped", receipt: 0, retryAfter: "9007199254740992", expected: { kind: "hold", reason: "range" } },
  { name: "50 adjacent huge decimal remains out of range", receipt: 0, retryAfter: "9007199254740993", expected: { kind: "hold", reason: "range" } },
  { name: "51 decimal ignores malformed response Date", receipt: 0, retryAfter: "120", serverDate: "bad", expected: { kind: "at", atMs: 120000, basis: "delay" } },
  { name: "52 IMF RFC example", receipt: 0, retryAfter: "Sun, 06 Nov 1994 08:49:37 GMT", expected: { kind: "at", atMs: 784111777000, basis: "date-local" } },
  { name: "53 asctime RFC example", receipt: 0, retryAfter: "Sun Nov  6 08:49:37 1994", expected: { kind: "at", atMs: 784111777000, basis: "date-local" } },
  { name: "54 RFC850 RFC example", receipt: 0, retryAfter: "Sunday, 06-Nov-94 08:49:37 GMT", expected: { kind: "at", atMs: 784111777000, basis: "date-local" } },
  { name: "55 preserve parser ASCII case compatibility", receipt: 0, retryAfter: " \tsUn, 06 nOv 1994 08:49:37 gMt\t ", expected: { kind: "at", atMs: 784111777000, basis: "date-local" } },
  { name: "56 asctime two-digit day", receipt: 0, retryAfter: "Sun Nov 06 08:49:37 1994", expected: { kind: "at", atMs: 784111777000, basis: "date-local" } },
  { name: "57 past absolute date is receipt-bounded", receipt: 1000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 1000, basis: "date-local" } },
  { name: "58 future absolute date wins", receipt: -1000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 0, basis: "date-local" } },
  { name: "59 equal absolute date", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 0, basis: "date-local" } },
  { name: "60 minimum semantic full year", receipt: -2208988800001, retryAfter: "Mon, 01 Jan 1900 00:00:00 GMT", expected: { kind: "at", atMs: -2208988800000, basis: "date-local" } },
  { name: "61 valid pre1900 syntax holds calendar", receipt: 0, retryAfter: "Sun, 31 Dec 1899 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "62 year zero syntax holds calendar", receipt: 0, retryAfter: "Sat, 01 Jan 0000 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "63 leap century 2000", receipt: 0, retryAfter: "Tue, 29 Feb 2000 00:00:00 GMT", expected: { kind: "at", atMs: 951782400000, basis: "date-local" } },
  { name: "64 pre1900 calendar precedes second60", receipt: 0, retryAfter: "Sun, 31 Dec 1899 23:59:60 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "65 valid IMF calendar retains unresolved second60", receipt: 0, retryAfter: "Tue, 29 Feb 2000 23:59:60 GMT", expected: { kind: "hold", reason: "leap-second" } },
  { name: "66 valid asctime calendar retains second60", receipt: 0, retryAfter: "Tue Feb 29 23:59:60 2000", expected: { kind: "hold", reason: "leap-second" } },
  { name: "67 50year threshold minus1ms selects invalid weekday century", receipt: 946684799999, retryAfter: "Saturday, 01-Jan-50 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "68 exactly50years stays future century", receipt: 946684800000, retryAfter: "Saturday, 01-Jan-50 00:00:00 GMT", expected: { kind: "at", atMs: 2524608000000, basis: "date-local" } },
  { name: "69 50year threshold plus1ms", receipt: 946684800001, retryAfter: "Saturday, 01-Jan-50 00:00:00 GMT", expected: { kind: "at", atMs: 2524608000000, basis: "date-local" } },
  { name: "70 prior-century weekday accepted before threshold", receipt: 946684799999, retryAfter: "Sunday, 01-Jan-50 00:00:00 GMT", expected: { kind: "at", atMs: 946684799999, basis: "date-local" } },
  { name: "71 cannot repair weekday at exact threshold", receipt: 946684800000, retryAfter: "Sunday, 01-Jan-50 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "72 cannot repair weekday after threshold", receipt: 946684800001, retryAfter: "Sunday, 01-Jan-50 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "73 Feb29 anniversary threshold minus1ms", receipt: 951825599999, retryAfter: "Monday, 28-Feb-50 12:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "74 Feb29 anniversary clamps to February28", receipt: 951825600000, retryAfter: "Monday, 28-Feb-50 12:00:00 GMT", expected: { kind: "at", atMs: 2529662400000, basis: "date-local" } },
  { name: "75 Feb29 anniversary threshold plus1ms", receipt: 951825600001, retryAfter: "Monday, 28-Feb-50 12:00:00 GMT", expected: { kind: "at", atMs: 2529662400000, basis: "date-local" } },
  { name: "76 Feb29 clamp companion accepts1950", receipt: 951825599999, retryAfter: "Tuesday, 28-Feb-50 12:00:00 GMT", expected: { kind: "at", atMs: 951825599999, basis: "date-local" } },
  { name: "77 Feb29 clamp does not search older weekday at boundary", receipt: 951825600000, retryAfter: "Tuesday, 28-Feb-50 12:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "78 Feb29 clamp does not search older weekday after boundary", receipt: 951825600001, retryAfter: "Tuesday, 28-Feb-50 12:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "79 yy00 selected2000 is leap", receipt: -626054400000, retryAfter: "Tuesday, 29-Feb-00 00:00:00 GMT", expected: { kind: "at", atMs: 951782400000, basis: "date-local" } },
  { name: "80 yy00 selected2100 cannot fall back2000", receipt: 2529705600000, retryAfter: "Tuesday, 29-Feb-00 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "81 selected valid leap date still checks weekday", receipt: -626054400000, retryAfter: "Monday, 29-Feb-00 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "82 selected valid leap date second60 holds", receipt: -626054400000, retryAfter: "Tuesday, 29-Feb-00 00:00:60 GMT", expected: { kind: "hold", reason: "leap-second" } },
  { name: "83 selected invalid leap century precedes second60", receipt: 2529705600000, retryAfter: "Tuesday, 29-Feb-00 00:00:60 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "84 server Date correction wins", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 180000, basis: "date-paired" } },
  { name: "85 negative Date delta never shortens", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:02:00 GMT", expected: { kind: "at", atMs: 60000, basis: "date-paired" } },
  { name: "86 equal epochs retain paired basis", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:01:00 GMT", expected: { kind: "at", atMs: 120000, basis: "date-paired" } },
  { name: "87 correction tie retains paired basis", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 60000, basis: "date-paired" } },
  { name: "88 nonwinning correction retains paired basis", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:01:00 GMT", expected: { kind: "at", atMs: 60000, basis: "date-paired" } },
  { name: "89 malformed Date ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "bad", expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "90 absent Date ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: absent, expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "91 explicit overlong Date ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: tooLong, expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "92 overlong Date value ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "9".repeat(257), expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "93 numeric Date is not a delay", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "0", expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "94 pre1900 Date ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Sun, 31 Dec 1899 00:00:00 GMT", expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "95 parser-invalid Date weekday ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Mon, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "96 unresolved Date weekday ignored after century selection", receipt: 946684800000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Monday, 01-Jan-00 00:00:00 GMT", expected: { kind: "at", atMs: 946684800000, basis: "date-local" } },
  { name: "97 Date second60 ignored", receipt: 120000, retryAfter: "Thu, 01 Jan 1970 00:01:00 GMT", serverDate: "Thu, 01 Jan 1970 00:00:60 GMT", expected: { kind: "at", atMs: 120000, basis: "date-local" } },
  { name: "98 Date century uses receipt not Retry-After epoch", receipt: 946684800000, retryAfter: "Sat, 01 Jan 2050 00:00:00 GMT", serverDate: "Saturday, 01-Jan-00 00:00:00 GMT", expected: { kind: "at", atMs: 2524608000000, basis: "date-paired" } },
  { name: "99 paired bound exactly upper epoch", receipt: 8639999999999000, retryAfter: "Thu, 01 Jan 1970 00:00:01 GMT", serverDate: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 8640000000000000, basis: "date-paired" } },
  { name: "100 usable pair overflow holds instead of local fallback", receipt: 8639999999999500, retryAfter: "Thu, 01 Jan 1970 00:00:01 GMT", serverDate: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "hold", reason: "range" } },
  { name: "101 lowest receipt with ordinary full date", receipt: -8640000000000000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 0, basis: "date-local" } },
  { name: "102 highest receipt needs no representable anniversary epoch", receipt: 8640000000000000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", expected: { kind: "at", atMs: 8640000000000000, basis: "date-local" } },
  { name: "103 tuple anniversary beyond domain selects275810 then rangeholds", receipt: 8640000000000000, retryAfter: "Monday, 01-Jan-10 00:00:00 GMT", expected: { kind: "hold", reason: "range" } },
  { name: "104 Date out-of-domain expansion cannot erase valid Retry-After", receipt: 8640000000000000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Monday, 01-Jan-10 00:00:00 GMT", expected: { kind: "at", atMs: 8640000000000000, basis: "date-local" } },
  { name: "105 negative-era RFC850 expansion is pre1900", receipt: -8640000000000000, retryAfter: "Monday, 01-Jan-00 00:00:00 GMT", expected: { kind: "hold", reason: "calendar" } },
  { name: "106 usable expanded year10000 has no9999 cap", receipt: 253402300799000, retryAfter: "Saturday, 01-Jan-00 00:00:00 GMT", expected: { kind: "at", atMs: 253402300800000, basis: "date-local" } },
  { name: "107 Date selected2100 leap failure ignored", receipt: 2529705600000, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Tuesday, 29-Feb-00 00:00:00 GMT", expected: { kind: "at", atMs: 2529705600000, basis: "date-local" } },
  { name: "108 minimum-year Date is independently usable", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Mon, 01 Jan 1900 00:00:00 GMT", expected: { kind: "at", atMs: 2208988800000, basis: "date-paired" } },
  { name: "109 RFC850 Date second60 ignored", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Tuesday, 29-Feb-00 00:00:60 GMT", expected: { kind: "at", atMs: 0, basis: "date-local" } },
  { name: "110 year-zero Date ignored", receipt: 0, retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT", serverDate: "Sat, 01 Jan 0000 00:00:00 GMT", expected: { kind: "at", atMs: 0, basis: "date-local" } },
];

describe("captured Retry-After minimum", () => {
  it.each(cases)("$name", ({ receipt, retryAfter, serverDate, expected }) => {
    const e = input(receipt, retryAfter, serverDate);
    const before = { received: { ...e.received }, retryAfter: { ...e.retryAfter }, serverDate: { ...e.serverDate } };
    const result = resolveRetryMinimum(e);
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(e).toEqual(before);
  });

  it("uses no ambient clock, date normalization, network, or timer entry", () => {
    const forbidden = (): never => { throw new Error("Unexpected ambient work"); };
    const original = {
      date: globalThis.Date,
      fetch: globalThis.fetch,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      queueMicrotask: globalThis.queueMicrotask,
    };
    const elapsed = vi.spyOn(performance, "now").mockImplementation(forbidden);
    let results: RetryMinimum[] = [];
    try {
      globalThis.Date = new Proxy(original.date, {
        apply: forbidden,
        construct: forbidden,
        get(target, key, receiver) {
          if (key === "now" || key === "parse" || key === "UTC") return forbidden;
          return Reflect.get(target, key, receiver);
        },
      });
      globalThis.fetch = new Proxy(original.fetch, { apply: forbidden });
      globalThis.setTimeout = new Proxy(original.setTimeout, { apply: forbidden });
      globalThis.clearTimeout = new Proxy(original.clearTimeout, { apply: forbidden });
      globalThis.setInterval = new Proxy(original.setInterval, { apply: forbidden });
      globalThis.clearInterval = new Proxy(original.clearInterval, { apply: forbidden });
      globalThis.queueMicrotask = new Proxy(original.queueMicrotask, { apply: forbidden });
      results = [
        resolveRetryMinimum(input(0, "120")),
        resolveRetryMinimum(input(946684800000, "Saturday, 01-Jan-50 00:00:00 GMT")),
        resolveRetryMinimum(input(120000, "Thu, 01 Jan 1970 00:01:00 GMT", "Thu, 01 Jan 1970 00:00:00 GMT")),
      ];
    } finally {
      globalThis.Date = original.date;
      globalThis.fetch = original.fetch;
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
      globalThis.queueMicrotask = original.queueMicrotask;
      elapsed.mockRestore();
    }
    expect(results).toEqual([
      { kind: "at", atMs: 120000, basis: "delay" },
      { kind: "at", atMs: 2524608000000, basis: "date-local" },
      { kind: "at", atMs: 180000, basis: "date-paired" },
    ]);
  });
});
