import { describe, expect, it } from "vitest";
import { contract } from "../rpc/contract";
import { capFilterName, FILTER_NAME_MAX, proposeLearnedFilters, type LearningAction } from "./propose";

const NOW = Date.UTC(2026, 9, 22);
const DAY = 86_400_000;
const act = (action: LearningAction["action"], fromEmail: string, over: Partial<LearningAction> = {}): LearningAction => ({
  action,
  fromEmail,
  fromDomain: fromEmail.split("@")[1]!,
  listId: null,
  at: NOW - DAY,
  ...over,
});
const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe("proposeLearnedFilters", () => {
  it("proposes a sender rule once support and confidence thresholds are met", () => {
    const actions = times(5, () => act("archive", "news@shop.com"));
    const [p, ...rest] = proposeLearnedFilters(actions, { now: NOW });
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ scope: "sender", value: "news@shop.com", action: "archive", support: 5, confidence: 1 });
    expect(p!.rule).toEqual({
      match: "all",
      conditions: [{ field: "from", op: "equals", value: "news@shop.com" }],
      actions: [{ type: "archive" }],
    });
  });

  it("does not propose with too little support or mixed behaviour", () => {
    expect(proposeLearnedFilters(times(4, () => act("archive", "a@x.com")), { now: NOW })).toEqual([]);
    const mixed = [...times(5, () => act("archive", "a@x.com")), ...times(2, () => act("trash", "a@x.com"))];
    expect(proposeLearnedFilters(mixed, { now: NOW })).toEqual([]); // 5/7 = 71% < 85%
  });

  it("a single protective action (star/reply), even an old one, vetoes the sender", () => {
    const actions = [...times(10, () => act("trash", "boss@corp.io")), act("reply", "boss@corp.io", { at: NOW - 400 * DAY })];
    expect(proposeLearnedFilters(actions, { now: NOW })).toEqual([]);
  });

  it("ignores destructive actions outside the window", () => {
    const old = times(6, () => act("archive", "a@x.com", { at: NOW - 90 * DAY }));
    expect(proposeLearnedFilters(old, { now: NOW, windowDays: 60 })).toEqual([]);
  });

  it("prefers a List-Id rule and suppresses the redundant sender rule it covers", () => {
    const actions = times(6, () => act("archive", "noreply@github.com", { listId: "repo.github.com" }));
    const proposals = proposeLearnedFilters(actions, { now: NOW });
    expect(proposals.map((p) => p.key)).toEqual(["list:repo.github.com:archive"]);
  });

  it("proposes a domain rule only for multiple senders and never for consumer domains", () => {
    const corp = [...times(3, () => act("spam", "a@spammy.biz")), ...times(3, () => act("spam", "b@spammy.biz"))];
    const proposals = proposeLearnedFilters(corp, { now: NOW });
    expect(proposals.map((p) => p.key)).toEqual(["domain:spammy.biz:spam"]);

    const gmail = [...times(3, () => act("spam", "a@gmail.com")), ...times(3, () => act("spam", "b@gmail.com"))];
    expect(proposeLearnedFilters(gmail, { now: NOW })).toEqual([]);
  });

  it("skips excluded (dismissed or already accepted) keys", () => {
    const actions = times(5, () => act("archive", "news@shop.com"));
    expect(proposeLearnedFilters(actions, { now: NOW, excludedKeys: new Set(["sender:news@shop.com:archive"]) })).toEqual([]);
  });

  it("an accepted/dismissed list rule still covers its senders (no redundant follow-up)", () => {
    const actions = times(6, () => act("archive", "noreply@github.com", { listId: "repo.github.com" }));
    expect(proposeLearnedFilters(actions, { now: NOW, excludedKeys: new Set(["list:repo.github.com:archive"]) })).toEqual([]);
  });

  it("normalizes addresses so case variants accumulate together", () => {
    const actions = [...times(3, () => act("archive", "News@Shop.com")), ...times(2, () => act("archive", "news@shop.com"))];
    expect(proposeLearnedFilters(actions, { now: NOW })).toHaveLength(1);
  });

  it("orders proposals by support", () => {
    const actions = [...times(5, () => act("archive", "a@one.com")), ...times(9, () => act("trash", "b@two.com"))];
    expect(proposeLearnedFilters(actions, { now: NOW }).map((p) => p.value)).toEqual(["b@two.com", "a@one.com"]);
  });
});

describe("learned filter names", () => {
  it("fit what learning.accept, filters.save and exports take, whatever the value's length", () => {
    const long = `Archive: ${"news.".repeat(80)}example.com`;
    const name = capFilterName(long);
    expect([...name].length).toBe(FILTER_NAME_MAX);
    expect(name.endsWith("…")).toBe(true);
    expect(() => contract["learning.accept"].params.parse({ key: "k", name })).not.toThrow();
    // a short one is left alone
    expect(capFilterName("Archivar: uber.com")).toBe("Archivar: uber.com");
    // emoji and accents are never cut in half
    expect(capFilterName("Á".repeat(200))).toBe(`${"Á".repeat(FILTER_NAME_MAX - 1)}…`);
  });
});
