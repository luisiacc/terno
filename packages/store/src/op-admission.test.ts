import { describe, expect, it } from "vitest";
import { copyOpAdmission, opAdmitter } from "./provider-cooldown";

describe("op admission per OAuth kind (plan 259)", () => {
  const gmail = 1, outlook = 2, imap = 3;
  const kindOf = (id: number) => ({ 1: "gmail", 2: "outlook", 3: "imap" })[id];
  const admits = (admission: Parameters<typeof opAdmitter>[0], id: number, op = "archive") => opAdmitter(admission)(id, kindOf(id), op);

  it("a kind's lanes hold only its own accounts", () => {
    const allGmail = { blockedAccountIds: [], verifiedAccountIds: [], kinds: { gmail: { all: true, unverified: false } } };
    expect(admits(allGmail, gmail)).toBe(false);
    expect(admits(allGmail, outlook)).toBe(true);
    expect(admits(allGmail, imap)).toBe(true);
    const allOutlook = { blockedAccountIds: [], verifiedAccountIds: [], kinds: { outlook: { all: true, unverified: false } } };
    expect(admits(allOutlook, gmail)).toBe(true);
    expect(admits(allOutlook, outlook)).toBe(false);
  });

  it("lanes, verification, blocks and pauses", () => {
    const lanes = { blockedAccountIds: [], verifiedAccountIds: [], kinds: { gmail: { all: false, unverified: false, sends: true } } };
    expect(admits(lanes, gmail, "send")).toBe(false);
    expect(admits(lanes, gmail, "archive")).toBe(true);
    const unverified = { blockedAccountIds: [], verifiedAccountIds: [outlook], kinds: { gmail: { all: false, unverified: true }, outlook: { all: false, unverified: true } } };
    expect(admits(unverified, gmail)).toBe(false);
    expect(admits(unverified, outlook)).toBe(true);
    expect(admits({ blockedAccountIds: [outlook], verifiedAccountIds: [], kinds: {} }, outlook)).toBe(false);
    expect(admits({ blockedAccountIds: [imap], verifiedAccountIds: [], kinds: {} }, imap)).toBe(true);
    expect(admits({ blockedAccountIds: [], pausedAccountIds: [imap], verifiedAccountIds: [], kinds: {} }, imap)).toBe(false);
  });

  it("refuses an admission naming a kind that isn't OAuth, or malformed lanes", () => {
    expect(() => copyOpAdmission({ blockedAccountIds: [], verifiedAccountIds: [], kinds: { imap: { all: true, unverified: false } } as never })).toThrow();
    expect(() => copyOpAdmission({ blockedAccountIds: [], verifiedAccountIds: [], kinds: { gmail: { all: "yes", unverified: false } } as never })).toThrow();
    expect(() => copyOpAdmission({ blockedAccountIds: [], verifiedAccountIds: [] } as never)).toThrow();
    expect(copyOpAdmission()).toEqual({ blockedAccountIds: [], verifiedAccountIds: [], kinds: {} });
  });
});
