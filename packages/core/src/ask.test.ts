import { describe, expect, it } from "vitest";
import { answerWithoutCitations, askOperandsMissing, askSpecifics, buildAskSearch, hasUnlinkedSentence, resolveCitations, validAskQueries } from "./ask";

const NOW = new Date(2026, 10, 5, 12).getTime();

describe("a planned query becomes a structured search (plan 141 revision 4)", () => {
  it("every query looks in all mail, never Spam or Trash, whatever a value says", () => {
    const search = buildAskSearch({ terms: ['in:spam', 'lease" in:trash "x'] }, NOW)!;
    expect(search.view).toBe("all");
    expect(search.query.view).toBe("all");
    expect(search.query.terms.map((t) => [t.field, t.value])).toEqual([["text", "in:spam"], ["text", 'lease" in:trash "x']]);
    expect(search.accountIds).toBeNull();
  });

  it("a value with no words goes; a query with nothing left is dropped; the rest stay", () => {
    expect(buildAskSearch({ terms: ["  ", "!!"] }, NOW)).toBeNull();
    expect(validAskQueries([{ terms: ["!!"] }, { terms: ["lease"] }], NOW).map((v) => v.plan.terms)).toEqual([["lease"]]);
    const q = buildAskSearch({ terms: ["lease"], anyOf: [["only one"], ["a", "b"], ["!!"]] }, NOW)!;
    expect(q.query.terms.map((t) => t.value)).toEqual(["lease", "only one"]);
    expect(q.query.anyOf.map((g) => g.map((t) => t.value))).toEqual([["a", "b"]]);
  });

  it("dates must parse, and after can't be later than today; a bad one goes without losing the query", () => {
    const bad = buildAskSearch({ terms: ["lease"], after: "next tuesday", before: "2026-13-40" }, NOW)!;
    expect(bad.query.after).toBeUndefined();
    expect(bad.query.before).toBeUndefined();
    expect(buildAskSearch({ terms: ["lease"], after: "2099-01-01" }, NOW)!.query.after).toBeUndefined();
    expect(buildAskSearch({ terms: ["lease"], after: "2026-01-01", before: "2026-06-01" }, NOW)!.query).toMatchObject({ after: new Date(2026, 0, 1).getTime(), before: new Date(2026, 5, 1).getTime() });
  });

  it("an address is that address; a name is a word of the header; lengths and counts are bounded", () => {
    expect(buildAskSearch({ terms: [], from: "Ana@X.test" }, NOW)!.query.terms[0]).toMatchObject({ field: "from", value: "ana@x.test" });
    expect(buildAskSearch({ terms: [], from: "Ana Ruiz" }, NOW)!.query.terms[0]).toMatchObject({ field: "from", value: "Ana Ruiz", phrase: true });
    expect(buildAskSearch({ terms: [], to: "bo@x.test" }, NOW)!.query.terms[0]).toMatchObject({ field: "address", value: "bo@x.test" });
    const many = buildAskSearch({ terms: Array.from({ length: 20 }, (_, i) => `w${i}`) }, NOW)!;
    expect(many.query.terms).toHaveLength(6);
    expect(buildAskSearch({ terms: ["x".repeat(500)] }, NOW)!.query.terms[0]!.value).toHaveLength(100);
    expect(validAskQueries(Array.from({ length: 9 }, () => ({ terms: ["a"] })), NOW)).toHaveLength(3);
  });
});

describe("the answer's checks (plan 141 revision 6)", () => {
  it("catches a wrong year, where a draft's check compares month and day", () => {
    expect(askSpecifics("It renews on 1 March 2027.", ["Your lease renews on 1 March 2026."])).toEqual(["2027-3-1"]);
    expect(askSpecifics("It renews on 1 March 2026.", ["Your lease renews on 1 March 2026."])).toEqual([]);
    expect(askSpecifics("It renews on 1 de marzo de 2026.", ["2026-03-01"])).toEqual([]);
    // a date with no year stands for any year's: "as of 3 March"
    expect(askSpecifics("As of 3 March it's fine.", ["2026-03-03"])).toEqual([]);
  });

  it("a code is exact: a leading zero and a digit off are different codes", () => {
    expect(askSpecifics("The code is 0421.", ["The code is 421."])).toEqual(["0421"]);
    expect(askSpecifics("The code is 4921.", ["The code is 4922."])).toEqual(["4921"]);
    expect(askSpecifics("The code is 4921.", ["Door: 4921"])).toEqual([]);
    expect(askSpecifics("It costs 1,200.", ["It costs 1200 a month."])).toEqual([]);
  });

  it("brackets are looked in, citations aren't numbers; an invented link or address is named", () => {
    expect(askSpecifics("Code [4921]. [m1] [2]", ["nothing"])).toEqual(["4921"]);
    expect(askSpecifics("Go to https://evil.test/a and write to a@evil.test.", ["https://good.test b@good.test"])).toEqual(["https://evil.test/a", "a@evil.test"]);
  });
});

describe("citations (plan 141)", () => {
  const labels = new Map([["m1", 0], ["m2", 1], ["m3", 2]]);

  it("numbers what's cited in order of appearance; a label that isn't there is dropped and counted", () => {
    const r = resolveCitations("It renews in March [m3]. Notice is 60 days [m1]. Also [m3] and [m99].", labels);
    expect(r.text).toBe("It renews in March [1]. Notice is 60 days [2]. Also [1] and.");
    expect(r.cited).toEqual([2, 0]);
    expect(r.dropped).toBe(1);
  });

  it("a claim with no citation is what 'not linked' means; copying takes them out", () => {
    expect(hasUnlinkedSentence("It renews in March. [1]")).toBe(false);
    expect(hasUnlinkedSentence("It renews in March [1]. Notice runs for sixty days.")).toBe(true);
    expect(answerWithoutCitations("It renews in March [1]. Notice [2]")).toBe("It renews in March. Notice");
  });
});

describe("a machine sum's amounts (plan 154)", () => {
  it("are found however the mail writes them, and flagged when no mail holds them", () => {
    expect(askOperandsMissing(["120.50", "80", "1234.56", "0.001"], ["paid 120,50 then 80.00, then 1.234,56 and BTC 0.001"])).toEqual([]);
    expect(askOperandsMissing(["7777"], ["paid 80"])).toEqual(["7777"]);
  });
});
