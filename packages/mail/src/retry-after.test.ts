import { describe, expect, it, vi } from "vitest";
import { parseHttpDate, parseRetryAfter, type HttpDateParts } from "./retry-after";
import type { BoundedHttpHeader } from "./types";

const field = (value: string): BoundedHttpHeader => Object.freeze({ kind: "value", value });
const january: HttpDateParts = { form: "imf-fixdate", year: { kind: "full", value: 2000 }, month: 1, day: 1, weekday: 6, hour: 0, minute: 0, second: 0 };
const dateResult = (parts: HttpDateParts) => ({ kind: "http-date", parts });

it.each([
  ["0", "0"], ["0000", "0"], ["000120", "120"], [" \t00120\t ", "120"],
  ["9007199254740993", "9007199254740993"], ["9".repeat(256), "9".repeat(256)], ["0".repeat(255) + "1", "1"],
])("preserves exact decimal seconds %s", (raw, decimal) => {
  expect(parseRetryAfter(field(raw!))).toEqual({ kind: "delay-seconds", decimal });
  expect(parseHttpDate(field(raw!))).toEqual({ kind: "invalid" });
});

const dates: [string, HttpDateParts][] = [
  ["Sat, 01 Jan 2000 00:00:00 GMT", january],
  ["Saturday, 01-Jan-00 00:00:00 GMT", { ...january, form: "rfc850", year: { kind: "two-digit", value: 0 } }],
  ["Sat Jan  1 00:00:00 2000", { ...january, form: "asctime" }],
  ["Sat Jan 01 00:00:00 2000", { ...january, form: "asctime" }],
  ["Sun, 02 Jan 2000 00:00:00 GMT", { ...january, day: 2, weekday: 0 }],
  ["Mon, 03 Jan 2000 00:00:00 GMT", { ...january, day: 3, weekday: 1 }],
  ["Tue, 04 Jan 2000 00:00:00 GMT", { ...january, day: 4, weekday: 2 }],
  ["Wed, 05 Jan 2000 00:00:00 GMT", { ...january, day: 5, weekday: 3 }],
  ["Thu, 06 Jan 2000 00:00:00 GMT", { ...january, day: 6, weekday: 4 }],
  ["Fri, 07 Jan 2000 00:00:00 GMT", { ...january, day: 7, weekday: 5 }],
  ["Tue, 29 Feb 2000 23:59:60 GMT", { ...january, month: 2, day: 29, weekday: 2, hour: 23, minute: 59, second: 60 }],
  ["Tue Feb 29 23:59:60 2000", { ...january, form: "asctime", month: 2, day: 29, weekday: 2, hour: 23, minute: 59, second: 60 }],
  ["Tuesday, 29-Feb-00 23:59:60 GMT", { ...january, form: "rfc850", year: { kind: "two-digit", value: 0 }, month: 2, day: 29, weekday: 2, hour: 23, minute: 59, second: 60 }],
  ["Tue, 29 Feb 2400 00:00:00 GMT", { ...january, year: { kind: "full", value: 2400 }, month: 2, day: 29, weekday: 2 }],
  ["Sat, 01 Jan 0000 00:00:00 GMT", { ...january, year: { kind: "full", value: 0 } }],
  ["Tue, 29 Feb 0000 00:00:00 GMT", { ...january, year: { kind: "full", value: 0 }, month: 2, day: 29, weekday: 2 }],
  ["Thu, 01 Jan 0099 00:00:00 GMT", { ...january, year: { kind: "full", value: 99 }, weekday: 4 }],
  ["Fri, 31 Dec 9999 23:59:59 GMT", { ...january, year: { kind: "full", value: 9999 }, month: 12, day: 31, weekday: 5, hour: 23, minute: 59, second: 59 }],
  ["Monday, 01-Jan-00 00:00:00 GMT", { ...january, form: "rfc850", year: { kind: "two-digit", value: 0 }, weekday: 1 }],
  ["Tue, 01 Feb 2000 00:00:00 GMT", { ...january, month: 2, weekday: 2 }],
  ["Wed, 01 Mar 2000 00:00:00 GMT", { ...january, month: 3, weekday: 3 }],
  ["Sat, 01 Apr 2000 00:00:00 GMT", { ...january, month: 4 }],
  ["Mon, 01 May 2000 00:00:00 GMT", { ...january, month: 5, weekday: 1 }],
  ["Thu, 01 Jun 2000 00:00:00 GMT", { ...january, month: 6, weekday: 4 }],
  ["Sat, 01 Jul 2000 00:00:00 GMT", { ...january, month: 7 }],
  ["Tue, 01 Aug 2000 00:00:00 GMT", { ...january, month: 8, weekday: 2 }],
  ["Fri, 01 Sep 2000 00:00:00 GMT", { ...january, month: 9, weekday: 5 }],
  ["Sun, 01 Oct 2000 00:00:00 GMT", { ...january, month: 10, weekday: 0 }],
  ["Wed, 01 Nov 2000 00:00:00 GMT", { ...january, month: 11, weekday: 3 }],
  ["Fri, 01 Dec 2000 00:00:00 GMT", { ...january, month: 12, weekday: 5 }],
  ["Friday, 29-Feb-04 00:00:00 GMT", { ...january, form: "rfc850", year: { kind: "two-digit", value: 4 }, month: 2, day: 29, weekday: 5 }],
];

const caseVariants: [string, HttpDateParts][] = [
  ...[
    "sat, 01 Jan 2000 00:00:00 GMT", "SAT, 01 Jan 2000 00:00:00 GMT", "sAt, 01 Jan 2000 00:00:00 GMT",
    "Sat, 01 jan 2000 00:00:00 GMT", "Sat, 01 JAN 2000 00:00:00 GMT", "Sat, 01 jAn 2000 00:00:00 GMT",
    "Sat, 01 Jan 2000 00:00:00 gmt", "Sat, 01 Jan 2000 00:00:00 Gmt", "Sat, 01 Jan 2000 00:00:00 gMT",
  ].map((raw): [string, HttpDateParts] => [raw, january]),
  ...[
    "saturday, 01-Jan-00 00:00:00 GMT", "SATURDAY, 01-Jan-00 00:00:00 GMT", "Saturday, 01-jAn-00 00:00:00 GMT", "Saturday, 01-Jan-00 00:00:00 gmt",
  ].map((raw): [string, HttpDateParts] => [raw, { ...january, form: "rfc850", year: { kind: "two-digit", value: 0 } }]),
  ...[
    "sat Jan  1 00:00:00 2000", "SAT Jan  1 00:00:00 2000", "Sat jan  1 00:00:00 2000", "Sat JAN  1 00:00:00 2000",
  ].map((raw): [string, HttpDateParts] => [raw, { ...january, form: "asctime" }]),
];

const invalidDates = [
  "Mon, 01 Jan 2000 00:00:00 GMT", "Thu, 29 Feb 1900 00:00:00 GMT", "Mon, 29 Feb 2100 00:00:00 GMT",
  "Sat, 31 Apr 2000 00:00:00 GMT", "Sat, 00 Jan 2000 00:00:00 GMT", "Sat, 32 Jan 2000 00:00:00 GMT",
  "Sat, 01 Foo 2000 00:00:00 GMT", "Sat, 01 Jan 2000 24:00:00 GMT", "Sat, 01 Jan 2000 00:60:00 GMT", "Sat, 01 Jan 2000 00:00:61 GMT",
  "Saturday, 29-Feb-01 00:00:00 GMT", "Saturday, 30-Feb-00 00:00:00 GMT", "Saturday, 31-Apr-00 00:00:00 GMT",
  "Sat Jan 1 00:00:00 2000", "Sat Jan   1 00:00:00 2000", "Sat Jan  1 00:00:00 2000 GMT",
  "Sat, 1 Jan 2000 00:00:00 GMT", "Sat, 01 January 2000 00:00:00 GMT", "Sat, 01 Jan 2000 00:00 GMT",
  "Sat, 01 Jan 2000 00:00:00 UTC", "Sat, 01 Jan 2000 00:00:00 +0000", "2000-01-01T00:00:00Z",
  "Sat, 01 Jan 2000 00:00:00 GMT, Sat, 01 Jan 2000 00:00:00 GMT", "Sat, 01 Jan 2000 00:00:00 GMT (comment)",
  "Sat,  01 Jan 2000 00:00:00 GMT", "Sat,\t01 Jan 2000 00:00:00 GMT", "Sat, 01 Jan 2000 00:00:00 GMT\n",
  "Sat, 01 Jan 2000 00:00:00 GMT\r", "Sat, 01 Jan 2000 00:00:00 GMT\u2028", "Sat, 01 Jan 2000 00:00:00 GMT\0",
  "Sat, 01 Jan 2000 00:00:00 GMTx", "ſat, 01 Jan 2000 00:00:00 GMT", "\u00a0Sat, 01 Jan 2000 00:00:00 GMT",
];

describe.each([["Retry-After", parseRetryAfter], ["HTTP-date", parseHttpDate]] as const)("%s syntax", (_name, parse) => {
  it.each(dates)("decodes %s without resolving its instant", (raw, parts) => {
    expect(parse(field(raw))).toEqual(dateResult(parts));
  });
  it.each(caseVariants)("accepts the explicitly permitted ASCII case variant %s", (raw, parts) => {
    expect(parse(field(raw))).toEqual(dateResult(parts));
  });
  it("strips only outer ASCII space/tab and preserves input", () => {
    const header = field(" \tSat, 01 Jan 2000 00:00:00 GMT\t ");
    expect(parse(header)).toEqual(dateResult(january));
    expect(header).toEqual({ kind: "value", value: " \tSat, 01 Jan 2000 00:00:00 GMT\t " });
  });
  it.each(invalidDates)("rejects malformed or impossible date %s", (raw) => {
    expect(parse(field(raw))).toEqual({ kind: "invalid" });
  });
  it("preserves unavailable evidence and enforces the original UTF16 bound", () => {
    expect(parse({ kind: "not-visible" })).toEqual({ kind: "not-visible" });
    expect(parse({ kind: "too-long" })).toEqual({ kind: "too-long" });
    for (const raw of ["0".repeat(257), " " + "1".repeat(255) + "\t", "😀".repeat(129), "x".repeat(4096)]) expect(parse(field(raw))).toEqual({ kind: "too-long" });
    expect(parse(field(""))).toEqual({ kind: "invalid" }); expect(parse(field(" \t"))).toEqual({ kind: "invalid" });
  });
  it("does not read clocks or use Date parsing/UTC normalization", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Unexpected clock"); });
    const dateParse = vi.spyOn(Date, "parse").mockImplementation(() => { throw new Error("Unexpected Date parser"); });
    const utc = vi.spyOn(Date, "UTC").mockImplementation(() => { throw new Error("Unexpected Date normalization"); });
    try {
      expect(parse(field("Sat, 01 Jan 0000 00:00:00 GMT"))).toEqual(dateResult({ ...january, year: { kind: "full", value: 0 } }));
      expect(parse(field("Monday, 01-Jan-00 00:00:00 GMT"))).toEqual(dateResult({ ...january, form: "rfc850", year: { kind: "two-digit", value: 0 }, weekday: 1 }));
    } finally { now.mockRestore(); dateParse.mockRestore(); utc.mockRestore(); }
  });
});

it.each(["-1", "+1", "1.5", "1e3", "Infinity", "NaN", "１２", "١٢", "1 second", "1, 2", "1\t2", "120\n", "\u00a0120", "120\r\n"])("rejects a nondecimal directive %s", (raw) => {
  expect(parseRetryAfter(field(raw))).toEqual({ kind: "invalid" });
});
