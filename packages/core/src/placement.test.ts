import { describe, expect, it } from "vitest";
import { orderReasons, parsePlacementDetail, placementCategory, placementJson, placementLive, PUT_AWAY_MS, ruleHash, type PlacementDetail } from "./placement";

const rule: PlacementDetail = { by: "rule", filterId: 4, name: "Xataka", auto: false, source: "manual", createdAt: 1, action: "archive", ruleHash: ruleHash({ a: 1 }), fromName: "Xataka" };
const terno: PlacementDetail = { by: "terno", categoryId: 2, reasons: [{ k: "reason.sameSender", p: { count: 12, category: "Facturas" } }], sender: "recibos@rappi.com", fromName: "Rappi" };

describe("placements (plan 282)", () => {
  it("round-trips both kinds, and reads anything else as nothing", () => {
    expect(parsePlacementDetail(placementJson(rule))).toEqual(rule);
    expect(parsePlacementDetail(placementJson(terno))).toEqual(terno);
    expect(parsePlacementDetail("{")).toBeNull();
    expect(parsePlacementDetail(JSON.stringify({ by: "gmail" }))).toBeNull();
    expect(parsePlacementDetail(JSON.stringify({ ...rule, action: "spam" }))).toBeNull();
    // stored reasons go through the reasons' own reader: a malformed one is dropped, never trusted
    expect(parsePlacementDetail(JSON.stringify({ ...terno, reasons: [{ k: "reason.newSender" }, { nope: 1 }, "old words"] }))).toMatchObject({ reasons: [{ k: "reason.newSender" }, "old words"] });
  });

  it("a rule's hash follows the rule", () => {
    expect(ruleHash({ a: 1 })).toBe(ruleHash({ a: 1 }));
    expect(ruleHash({ a: 1 })).not.toBe(ruleHash({ a: 2 }));
  });

  it("is listed for 7 days", () => {
    expect(placementLive(1000, 1000 + PUT_AWAY_MS - 1)).toBe(true);
    expect(placementLive(1000, 1000 + PUT_AWAY_MS)).toBe(false);
  });

  it("says who the user keeps there first, never counter-evidence or a new sender", () => {
    const words = { k: "reason.mentions", p: { count: 1, a: "factura", b: "", c: "" } } as const;
    const same = { k: "reason.sameSender", p: { count: 12, category: "Facturas" } } as const;
    expect(orderReasons([words, same, { k: "reason.alsoElsewhere", p: { sender: "x" } }])).toEqual({ lead: same, rest: [words] });
    expect(orderReasons([{ k: "reason.newSender" }, { k: "reason.intent.invoice" }])).toEqual({ lead: { k: "reason.intent.invoice" }, rest: [] });
    expect(orderReasons([{ k: "reason.newSender" }])).toEqual({ lead: null, rest: [] });
  });

  it("names its category: Terno's filing, a rule's filing; none for an archive", () => {
    expect(placementCategory(terno)).toBe(2);
    expect(placementCategory({ ...rule, action: "addCategory", categoryId: 7 })).toBe(7);
    expect(placementCategory(rule)).toBeNull();
  });
});
