import type { TheirMailResult } from "@terno/ai";
import { THEIRS_ITEM, type FollowupRow } from "@terno/core";
import { describe, expect, it } from "vitest";
import { checkTheirPromises, deliveredIn, fileNames, owedWorth, saysNotYet } from "./their-promises";

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
// Monday 2 March 2026
const MADE = at(2026, 3, 2, 11);
const row = (id: number, text: string): FollowupRow => ({ id, revision: 3, threadId: 1, messageId: 9, rfcMessageId: null, item: THEIRS_ITEM, kind: "theirs", text, quote: "q", personName: "Alex", personEmail: "alex@acme.test", sentAt: MADE - 86_400_000, dueAt: MADE, dated: true, deferredUntil: null, state: "open", inboxState: "none", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision_: undefined, model: null, provider: null, createdAt: 0 } as unknown as FollowupRow);
const empty: TheirMailResult = { promises: [], kept: [], moved: [], withdrawn: [] };
const check = (result: Partial<TheirMailResult>, over: Partial<Parameters<typeof checkTheirPromises>[1]> = {}) =>
  checkTheirPromises({ ...empty, ...result }, { text: "Hi Nora, I'll send you the contract by Thursday. Here's the deck.", attachments: [], owed: new Map(), from: { name: "Alex Reed", email: "alex@acme.test" }, reader: { name: "Nora Quill", addressed: "to" }, relay: null, madeAt: MADE, nudgeAfterDays: 5, ...over });
const promise = (over: Partial<TheirMailResult["promises"][number]> = {}) => ({ text: "send you the contract", quote: "I'll send you the contract by Thursday", due: "2026-03-05", partOfDay: null, firm: true, ...over });

describe("their promises' checks (plan 280)", () => {
  it("a promise is the sender's, in their words, late one working day after its day", () => {
    const { rows } = check({ promises: [promise(), promise({ quote: "words nobody wrote" })] });
    expect(rows).toEqual([{ item: THEIRS_ITEM, text: "send you the contract", quote: "I'll send you the contract by Thursday", personName: "Alex Reed", personEmail: "alex@acme.test", dueAt: at(2026, 3, 6, 9), dated: true, dueDay: "2026-03-05", firm: true }]);
  });

  it("a date that isn't one, or is past, is undated; a tentative one stays tentative", () => {
    expect(check({ promises: [promise({ due: "someday" })] }).rows[0]).toMatchObject({ dated: false, dueDay: null });
    expect(check({ promises: [promise({ due: "2026-02-20" })] }).rows[0]).toMatchObject({ dated: false });
    expect(check({ promises: [promise({ firm: false })] }).rows[0]!.firm).toBe(false);
  });

  it("only copied, a promise is the reader's only when it names them; to a list or a blind copy, none is", () => {
    const cc = { reader: { name: "Nora Quill", addressed: "cc" as const } };
    expect(check({ promises: [promise()] }, cc).rows).toEqual([]);
    expect(check({ promises: [promise({ quote: "Hi Nora, I'll send you the contract by Thursday" })] }, cc).rows).toHaveLength(1);
    expect(check({ promises: [promise()] }, { reader: { name: "Nora Quill", addressed: "none" } }).rows).toEqual([]);
  });

  it("a label it wasn't given closes nothing; a delivery in their words keeps it; words that say it hasn't happened never do", () => {
    const owed = new Map([["t1", row(7, "send you the deck")]]);
    expect(check({ kept: [{ label: "t9", evidence: "Here's the deck." }] }, { owed }).kept).toEqual([]);
    expect(check({ kept: [{ label: "t1", evidence: "Here's the deck." }] }, { owed }).kept).toEqual([{ id: 7, revision: 3 }]);
    expect(check({ kept: [{ label: "t1", evidence: "the deck isn't ready yet" }] }, { owed, text: "Sorry, the deck isn't ready yet." }).kept).toEqual([]);
    expect(check({ kept: [{ label: "t1", evidence: "words nobody wrote" }] }, { owed }).kept).toEqual([]);
  });

  it("a file keeps it only by its exact name, naming the thing, and no other open promise of theirs", () => {
    const owed = new Map([["t1", row(7, "send you the signed contract")], ["t2", row(8, "send you the deck")]]);
    const files = { attachments: ["Contract_signed.pdf", "notes.txt"], text: "Hi Nora," };
    expect(check({ kept: [{ label: "t1", evidence: "Contract_signed.pdf" }] }, { owed, ...files }).kept).toEqual([{ id: 7, revision: 3 }]);
    expect(check({ kept: [{ label: "t2", evidence: "notes.txt" }] }, { owed, ...files }).kept).toEqual([]);
    const both = new Map([["t1", row(7, "send you the signed contract")], ["t2", row(8, "send you the contract draft")]]);
    expect(check({ kept: [{ label: "t1", evidence: "Contract_signed.pdf" }] }, { owed: both, ...files }).kept).toEqual([]);
  });

  it("a relay never closes: what it says arrived, in its own words, is a hint", () => {
    const owed = new Map([["t1", row(7, "send you the signed contract")]]);
    const relay = { block: "Alex Reed (alex@acme.test) signed Contract.pdf" };
    const r = check({ promises: [promise()], kept: [{ label: "t1", evidence: "Alex Reed (alex@acme.test) signed Contract.pdf" }], moved: [{ label: "t1", due: "2026-03-09", evidence: "x" }] }, { owed, relay, text: "Alex Reed (alex@acme.test) signed Contract.pdf. I'll send you the contract by Thursday" });
    expect(r).toEqual({ rows: [], kept: [], moved: [], withdrawn: [], hints: [{ id: 7, revision: 3 }] });
  });

  it("a move is a new day in their words, never past; kept wins over a move or a withdrawal", () => {
    const owed = new Map([["t1", row(7, "send you the deck")]]);
    const text = "I need until Monday for the deck. Sorry, we won't be able to send the slides.";
    expect(check({ moved: [{ label: "t1", due: "2026-03-09", evidence: "I need until Monday for the deck" }] }, { owed, text }).moved).toEqual([{ id: 7, revision: 3, dueAt: at(2026, 3, 10, 9), dueDay: "2026-03-09" }]);
    expect(check({ moved: [{ label: "t1", due: "2026-02-09", evidence: "I need until Monday for the deck" }] }, { owed, text }).moved).toEqual([]);
    expect(check({ withdrawn: [{ label: "t1", evidence: "Sorry, we won't be able to send the slides" }] }, { owed, text }).withdrawn).toEqual([{ id: 7, revision: 3 }]);
    const both = check({ kept: [{ label: "t1", evidence: "Here's the deck." }], withdrawn: [{ label: "t1", evidence: "Sorry, we won't be able to send the slides" }] }, { owed, text: `Here's the deck. ${text}` });
    expect([both.kept.length, both.withdrawn.length]).toEqual([1, 0]);
  });

  it("reads 'not yet' in English and Spanish, and a file's words", () => {
    expect(["the contract wasn't sent", "todavía no lo tengo", "still working on it", "not yet"].every(saysNotYet)).toBe(true);
    expect(["Here's the contract", "Te lo acabo de mandar"].some(saysNotYet)).toBe(false);
    expect(fileNames("Q3-Budget_final.xlsx", "send you the Q3 budget")).toBe(true);
    expect(fileNames("IMG_2041.jpg", "send you the Q3 budget")).toBe(false);
  });

  it("the code review: evidence cut out of a sentence that says it hasn't happened keeps nothing", () => {
    const owed = new Map([["t1", row(7, "send you the contract")]]);
    const text = "I can't send the contract until Friday, sorry.";
    expect(check({ kept: [{ label: "t1", evidence: "send the contract" }] }, { owed, text }).kept).toEqual([]);
    expect(deliveredIn("send the contract", text)).toBe(false);
    expect(deliveredIn("Here's the contract", "Here's the contract. Sorry it's late!")).toBe(true);
  });

  it("the code review: a file names a promise only when no other open one of theirs, shown or not, could be it", () => {
    const owed = new Map([["t1", row(7, "send you the signed contract")]]);
    const files = { attachments: ["Contract_signed.pdf"], text: "Hi Nora," };
    expect(check({ kept: [{ label: "t1", evidence: "Contract_signed.pdf" }] }, { owed, ...files }).kept).toEqual([{ id: 7, revision: 3 }]);
    expect(check({ kept: [{ label: "t1", evidence: "Contract_signed.pdf" }] }, { owed, ...files, debts: [row(9, "send you the contract draft")] }).kept).toEqual([]);
  });

  it("the code review: a reply to a send of yours is read with no cue at all (\"Friday.\")", () => {
    expect(owedWorth({ text: "Friday.", owed: 0, waiting: false })).toBe(false);
    expect(owedWorth({ text: "Friday.", owed: 0, waiting: false, answers: true })).toBe(true);
  });
});
