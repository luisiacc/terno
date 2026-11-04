import { describe, expect, it } from "vitest";
import { readCorpus, reduceMail, repeatedTrailers, TrailerCounter, withoutTrailers, writtenText } from "./extract";
import { computeHabits, habitsOf, mailFeatures, mergeHabits, mergePhrases, phraseSteps, stockPhrases } from "./habits";
import { canonicalAuthored, classifyEdit, repeatedCorrections } from "./provenance";
import { scopeKeys, type SentMail } from "./types";

const AT = Date.UTC(2026, 10, 1);
const sent = (id: number, body: string, over: Partial<SentMail> = {}): SentMail => ({ id, to: [`p${id % 4}@x.test`], cc: [], at: AT - id, body, isReply: false, ...over });

const BODIES = Array.from({ length: 30 }, (_, i) => `Hi there,\n\nThat works for the ${["plan", "launch", "budget", "copy"][i % 4]}, thanks a lot for this!\n\nOn Friday Tom wrote:\n> hello ${i}\n\nBest,\nMe\n\n--\nMe\nFounder at Acme Inc`);
const MAILS = BODIES.map((b, i) => sent(i, b));

describe("what a learner in slices does gives what the whole-corpus functions give", () => {
  it("trailers, counted a message at a time", () => {
    const counter = new TrailerCounter();
    for (const body of BODIES) counter.add(writtenText(body));
    expect([...counter.trailers()].sort()).toEqual([...repeatedTrailers(BODIES)].sort());
  });

  it("the text, when trailers come off afterwards", () => {
    const counter = new TrailerCounter();
    const written = BODIES.map((b) => writtenText(b));
    for (const w of written) counter.add(w);
    const trailers = counter.trailers();
    const stepped = MAILS.map((m, i) => reduceMail(m, withoutTrailers(written[i]!, trailers)));
    expect(stepped).toEqual(readCorpus(MAILS));
  });

  it("habits from features, phrases by steps", () => {
    const mails = readCorpus(MAILS);
    expect(habitsOf(mails.map(mailFeatures))).toEqual(computeHabits(mails));
    const steps = phraseSteps(mails);
    let yields = 0;
    let step = steps.next();
    while (!step.done) {
      yields++;
      step = steps.next();
    }
    expect(step.value).toEqual(stockPhrases(mails));
    expect(yields).toBeGreaterThanOrEqual(mails.length);
  });
});

describe("'you' from the accounts", () => {
  const a = computeHabits(readCorpus(Array.from({ length: 30 }, (_, i) => sent(i, "Thanks!\n\nThat works for me"))));
  const b = computeHabits(readCorpus(Array.from({ length: 10 }, (_, i) => sent(i, "Hola Ana,\n\nMe parece muy bien todo lo que me cuentas sobre esto, un saludo muy cordial para ti"))));

  it("weighs by volume: the bigger account decides the median, rates are exact", () => {
    const m = mergeHabits([a, b]);
    expect(m.messages).toBe(40);
    expect(m.words.median).toBe(a.words.median);
    expect(m.exclamation).toBeCloseTo((a.exclamation * 30 + b.exclamation * 10) / 40, 2);
    expect(m.oneToOne).toBe(1);
    expect(m.languages.reduce((n, l) => n + l.share, 0)).toBeLessThanOrEqual(1.01);
  });

  it("one account is itself, and none is nothing", () => {
    const one = mergeHabits([a]);
    expect(one.words).toEqual(a.words);
    expect(one.exclamation).toBe(a.exclamation);
    expect(mergeHabits([]).messages).toBe(0);
  });

  it("phrases in more accounts come first, once each, whatever the case", () => {
    expect(mergePhrases([["Let me know", "only here"], ["let me know", "and here"]])).toEqual(["Let me know", "only here", "and here"]);
    expect(mergePhrases([Array.from({ length: 30 }, (_, i) => `p${i}`)]).length).toBe(20);
  });
});

describe("provenance's comparison (§8)", () => {
  it("line endings, trailing space and blank runs aren't editing; a word is", () => {
    const form = "Hi Tom,\n\nThat works.";
    expect(canonicalAuthored("Hi Tom,\r\n\r\n\r\nThat works.  \n\n")).toBe(form);
    expect(canonicalAuthored("  Hi Tom, \n\nThat works.\n".trim())).toBe(form);
    expect(canonicalAuthored("Hi Tom,\n\nThat works!")).not.toBe(form);
  });

  it("says what changed in manner, never what the mail's about", () => {
    const generated = "Hi Tom,\n\nThat works, thanks for sending it over today!\n\nBest,\nMe";
    expect(classifyEdit(generated, "That works, thanks for sending it over today!\n\nBest,\nMe").map((c) => c.kind)).toEqual(["dropped-greeting"]);
    expect(classifyEdit(generated, "Hey Tom,\n\nThat works, thanks for sending it over today!\n\nBest,\nMe")[0]).toMatchObject({ kind: "changed-greeting" });
    expect(classifyEdit(generated, "Hi Tom,\n\nThat works, thanks for sending it over today!", ["Me"]).map((c) => c.kind)).toContain("dropped-sign-off");
    expect(classifyEdit(generated, generated.replace("Best,", "Cheers,"), ["Me"])[0]).toMatchObject({ kind: "changed-sign-off", value: "Cheers,\nMe" });
    expect(classifyEdit(generated, generated.replace("!", ".")).map((c) => c.kind)).toEqual(["removed-exclamation"]);
    expect(classifyEdit(generated, "Hi Tom,\n\nFine.\n\nBest,\nMe").map((c) => c.kind)).toContain("shorter");
    expect(classifyEdit("One two three four five six seven eight nine ten", `${"One two three four five six seven eight nine ten "}eleven twelve thirteen fourteen`).map((c) => c.kind)).toEqual(["longer"]);
    expect(classifyEdit(generated, generated)).toEqual([]);
  });

  it("a change counts from the third time, and backs off when it stops recurring", () => {
    const dropped = { generated: "Hi Tom,\n\nThat works.", final: "That works." };
    const kept = { generated: "Hi Tom,\n\nThat works.", final: "Hi Tom,\n\nWorks." };
    expect(repeatedCorrections([dropped, dropped])).toEqual([]);
    expect(repeatedCorrections([dropped, dropped, dropped])).toEqual(["when editing drafts they remove the greeting (3 times)"]);
    expect(repeatedCorrections([kept, dropped, kept, dropped, dropped])).toEqual(["when editing drafts they remove the greeting (3 times)"]);
    // newest first: six newer pairs without it
    expect(repeatedCorrections([kept, kept, kept, kept, kept, kept, dropped, dropped, dropped])).toEqual([]);
  });

  it("different changes of the same kind don't add up", () => {
    const to = (greeting: string) => ({ generated: "Hi Tom,\n\nThat works.", final: `${greeting},\n\nThat works.` });
    expect(repeatedCorrections([to("Hey Tom"), to("Dear Tom"), to("Hello Tom")])).toEqual([]);
  });
});

describe("scope keys", () => {
  it("is the one format, lowercased", () => {
    expect(scopeKeys.you).toBe("you");
    expect(scopeKeys.account(3)).toBe("account:3");
    expect(scopeKeys.domain(3, "ACME.com")).toBe("domain:3:acme.com");
    expect(scopeKeys.person(3, "Tom@Acme.com")).toBe("person:3:tom@acme.com");
  });
});
