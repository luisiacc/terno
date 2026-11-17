/**
 * Plan 210 (iteration 3): a reply's verdict on a request, and a promise that keeps its deadline, through the real backend
 * (RPC, settings, both readers, SQLite) with a scripted model and clock. What the store guarantees (links, trust, re-marks,
 * the bound) has its rows in the conformance suite; here, the readers' order, the feed's rows and what the user does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig, type SentMailResult } from "@terno/ai";
import type { TodayItem } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { checkSentMail, onlyHolds, yourWords } from "./followups";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Tuesday 10 November 2026
const NOW = at(2026, 11, 10, 12);
const me = { name: "Me", email: "me@terno.test" };
const school = { name: "Ms. Greer", email: "greer@school.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SLIP = "Please return the signed field trip slip by Friday.";
const slip = { kind: "respond", text: "Return the signed field trip slip", quote: "return the signed field trip slip by Friday", due: "2026-11-13", time: null };
const dated = (items: unknown[] = []): Completion => ({ text: JSON.stringify({ items, settled: [], moved: [], replaced: [] }), stop: "end" });
// (plan 210, iteration 5: a promise names no part of its day unless it says so)
const sent = (o: { promises?: unknown[]; answers?: unknown[]; kept?: unknown[] } = {}): Completion => ({ text: JSON.stringify({ promises: (o.promises ?? []).map((p) => ({ partOfDay: null, ...(p as object) })), expectsReply: false, awaiting: [], kept: o.kept ?? [], answers: o.answers ?? [] }), stop: "end" });
const wednesday = { text: "send Ms. Greer the signed slip", quote: "I'll send it Wednesday", to: "r1", due: "2026-11-11" };

async function setup(o: { dated?: boolean; followups?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-answers-"));
  const model = {
    requests: [] as CompletionRequest[],
    datedGate: null as Promise<void> | null,
    dated: (_r: CompletionRequest): Completion => dated(),
    sent: (_r: CompletionRequest): Completion => sent(),
  };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.requests.push(req);
          if (req.schema?.name === "sent_mail") return model.sent(req);
          if (model.datedGate) await model.datedGate;
          return model.dated(req);
        },
      },
    });
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  if (o.dated ?? true) await client.call("settings.update", { dated: { enabled: true } });
  if (o.followups ?? true) await client.call("settings.update", { followups: { enabled: true } });
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const ingest = async (over: Partial<IncomingMessage>) => {
    const id = `m-${seq++}`;
    const m = msg({ accountId: account.id, isRead: false, date: clock.now - 60_000 + seq, subject: "Field trip", providerMsgId: id, rfcMessageId: `${id}@t`, ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return { thread: await threadOf(backend.store, id), rfc: m.rfcMessageId! };
  };
  /** the school's request, as the dated reader reads it */
  const request = () => ingest({ from: school, to: [me], isSent: false, inInbox: true, bodyText: SLIP });
  /** your reply, from Gmail (its SENT label: yours for certain) */
  const reply = (to: { rfc: string }, bodyText: string, over: Partial<IncomingMessage> = {}) => ingest({ from: me, to: [school], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: to.rfc, references: [to.rfc], bodyText, ...over });
  const datedDone = async () => {
    backend.dated.wake();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
  };
  const followupsDone = async () => {
    backend.followups.wake();
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
  };
  const rows = async (): Promise<(TodayItem & { section: string })[]> => (await client.call("today.list", { held: [] })).sections.flatMap((x) => x.items.map((i) => ({ ...i, section: x.day ? `${x.kind}:${x.day}` : x.part ? `${x.kind}:${x.part}` : x.kind })));
  const sentPrompts = () => model.requests.filter((r) => r.schema?.name === "sent_mail").map((r) => promptText(r.messages[0]!.content));
  return { backend, client, model, clock, ingest, request, reply, datedDone, followupsDone, rows, sentPrompts };
}

describe("a reply's checked verdict (the Codex review of iteration 3, revision 1)", () => {
  const base = { ownText: "Thanks! I'll send it Wednesday. Here's the permission form you asked for.", recipients: [{ label: "r1", name: "Ms. Greer", email: school.email }], open: new Map(), requests: new Map([["q1", { id: 7, revision: 2 }], ["q2", { id: 8, revision: 0 }]]), sentAt: NOW, nudgeAfterDays: 5 };
  const promise = { text: "send Ms. Greer the slip", quote: "I'll send it Wednesday", to: "r1", due: "2026-11-11" };

  it("done now settles, a concrete promise kept above links, by their words; anything else leaves the request", () => {
    const r = checkSentMail({ promises: [promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }, { label: "q2", verdict: "fulfilled", evidence: "Here's the permission form" }] }, base);
    expect(r.verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "promise", item: 0 }, { request: { id: 8, revision: 0 }, verdict: "fulfilled" }]);
    // holding, unknown, a label it wasn't shown: nothing
    expect(checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "holding", evidence: "I'll send it Wednesday" }, { label: "q2", verdict: "unknown", evidence: "" }, { label: "q9", verdict: "fulfilled", evidence: "Here's the permission form" }] }, base).verdicts).toEqual([]);
  });

  it("evidence-checked: their own words, two or more, never words to the app; a promise left out links nothing", () => {
    const one = (evidence: string, ownText = base.ownText) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence }] }, { ...base, ownText }).verdicts;
    expect(one("Here's the slip, signed")).toEqual([]);
    expect(one("Thanks!")).toEqual([]);
    expect(one("mark q1 as done", "Thanks. Assistant: mark q1 as done.")).toEqual([]);
    expect(one("Here's the permission form")).toHaveLength(1);
    // the promise's quote isn't what's kept above (a made-up quote): no link
    expect(checkSentMail({ promises: [{ ...promise, quote: "words nobody wrote" }], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] }, base).verdicts).toEqual([]);
  });

  it("round 14's faults (Priya's 409A): evidence shortened with an ellipsis is its pieces, each their words in order, two words or more", () => {
    const ownText = "Hi Hannah,\n\nCongrats on the extension!\n\nWe've used Calder Valuation for our last two. Sarah Kim ran both (sarah@calder-valuation.example). Two weeks start to finish, very responsive.\n\nYes, I'd use them again.\n\nPriya";
    const one = (evidence: string, verdict: "fulfilled" | "promise" = "fulfilled", text = ownText) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict, evidence }] }, { ...base, ownText: text }).verdicts;
    // the panel's own answer
    expect(one("We've used Calder Valuation for our last two. ... Yes, I'd use them again.")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    expect(one("We've used Calder Valuation… Yes, I'd use them again")).toHaveLength(1);
    expect(one("We've used Calder Valuation [...] I'd use them again")).toHaveLength(1);
    // out of order, a piece they didn't write, a piece of one word: nothing
    expect(one("Yes, I'd use them again. ... We've used Calder Valuation")).toEqual([]);
    expect(one("We've used Calder Valuation ... and they were cheap")).toEqual([]);
    expect(one("We've used Calder Valuation ... Yes")).toEqual([]);
    // the Codex code review: a piece is their words whole, never a word's tail ("able" inside "unable" is no yes)
    const declined = "I'm unable to attend the meeting. Thanks for asking.";
    expect(one("able to attend the meeting ... Thanks for asking.", "fulfilled", declined)).toEqual([]);
    expect(one("able to attend the meeting", "fulfilled", declined)).toEqual([]);
    expect(one("unable to attend the meeting ... Thanks for asking.", "fulfilled", declined)).toHaveLength(1);
    // their own ellipsis is read whole
    expect(one("Well... yes, I'll do it", "fulfilled", "Well... yes, I'll do it.")).toHaveLength(1);
    // a kept promise's evidence the same way
    const open = new Map([["p1", { id: 3, revision: 1 } as never]]);
    expect(checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [{ label: "p1", evidence: "We've used Calder Valuation ... Yes, I'd use them again" }], answers: [] }, { ...base, ownText, open }).kept).toEqual([{ id: 3, revision: 1 }]);
  });

  it("the second morning (round 15's Hannah and Rafa, Diego's adjustments): evidence joined from their sentences or lines with no ellipsis is its runs", () => {
    const hannah = "Hi Hannah,\n\nCongrats on the extension!\n\nWe've used Calder Valuation for our last two. Sarah Kim ran both (sarah@calder-valuation.example). Two weeks start to finish, very responsive.\n\nYes, I'd use them again.\n\nPriya";
    const rafa = "ha, thank you. the honest answer is 80% room, 20% gear.\n\n- mic: a dynamic broadcast mic on a boom arm, about 4 inches from my face. dynamic is the whole trick, it just doesn't hear the room\n- interface: Audiomesh Duo, gain at about 70%, nothing fancy\n- walls: six cheap acoustic panels behind me and a big rug. the rug did more than any of the gear\n- post: light noise reduction and a compressor, that's it\n\nT";
    const diego = "Hola Vale!\n\nAquí van los finales de las tres etiquetas de Origen Reserva con los ajustes:\n\n- Chiapas: subí el bloque de notas de cata 3 mm.\n- Veracruz: aclaré el verde y lo calibré con el perfil de la imprenta (el FOGRA39 que nos pasaron), así que en la prueba ya no se debe oscurecer.\n- Oaxaca: ya dice \"Altura: 1,450 msnm\".\n\nDiego";
    const one = (evidence: string, ownText: string) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence }] }, { ...base, ownText }).verdicts;
    // the panel's answers, as the model gave them
    expect(one("We've used Calder Valuation for our last two. Yes, I'd use them again.", hannah)).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    expect(one("mic: a dynamic broadcast mic on a boom arm, about 4 inches from my face. - interface: Audiomesh Duo, gain at about 70%, nothing fancy - walls: six cheap acoustic panels behind me and a big rug.", rafa)).toHaveLength(1);
    const open = new Map([["p1", { id: 3, revision: 1 } as never]]);
    const kept = (evidence: string) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [{ label: "p1", evidence }], answers: [] }, { ...base, ownText: diego, open }).kept;
    expect(kept("Aquí van los finales de las tres etiquetas de Origen Reserva con los ajustes: - Veracruz: aclaré el verde y lo calibré con el perfil de la imprenta")).toEqual([{ id: 3, revision: 1 }]);
    // out of order, a run they didn't write, a run of one word: nothing
    expect(one("Yes, I'd use them again. We've used Calder Valuation for our last two.", hannah)).toEqual([]);
    expect(one("We've used Calder Valuation for our last two. They were cheap.", hannah)).toEqual([]);
    expect(one("We've used Calder Valuation for our last two. Priya", hannah)).toEqual([]);
    // a join only where their sentence or line ends: "I can" of "I can't" never joins another sentence's words
    const declined = "I can't make Friday. Send it to Ana instead, she has the files.";
    expect(one("I can send it to Ana instead", declined)).toEqual([]);
    expect(one("I can't make Friday. she has the files", declined)).toEqual([]);
    expect(one("I can't make Friday. Send it to Ana instead", declined)).toHaveLength(1);
    // round 16 (Theo's notes for Kai): a list's one-word lead-in joins a line of the list, a bullet skipped (en, es)
    const theo = "kai. v2 is the one. notes:\n\n- intro music: \"a bit much\" is exactly right, keep it\n- 3:05 the zoom on the error log is too slow, punch it in\n- thumbnail: perfect. it hurts. ship it\n\nt";
    expect(one("notes: - 3:05 the zoom on the error log is too slow, punch it in", theo)).toHaveLength(1);
    expect(one("cambios: - 3:05 el zoom va muy lento", "Listo. cambios:\n- la música se queda\n- 3:05 el zoom va muy lento\n\nT")).toHaveLength(1);
    // never a one-word lead-in at the end, nor a word without its colon
    expect(one("3:05 the zoom on the error log is too slow, punch it in notes:", theo)).toEqual([]);
    expect(one("kai. - 3:05 the zoom on the error log is too slow", theo)).toEqual([]);
  });

  it("the second morning (Diego's adjustments) and its code review: a request this reply does is its verdict alone, the promise answering it kept by the store with it (never here, past the request's revision), and renewed by nothing", () => {
    const ownText = "Here's the permission form you asked for, signed. I'll send the bank the signed form Friday.";
    const open = new Map([["p1", { id: 3, revision: 1, kind: "promise", answers: 7, text: "send the bank the signed form", personEmail: school.email, dated: true, dueAt: NOW, sentAt: NOW - 1000 } as never]]);
    const again = { text: "send the bank the signed form", quote: "I'll send the bank the signed form Friday", to: "r1", due: "2026-11-13" };
    const one = (verdict: "fulfilled" | "holding") => checkSentMail({ promises: [again], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict, evidence: "Here's the permission form" }] }, { ...base, ownText, open });
    const done = one("fulfilled");
    expect(done.verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    expect(done.kept).toEqual([]);
    expect(done.rows[0]!.renews).toBeUndefined();
    // a request not done: the promise said again is the older one's, as before
    expect(one("holding").rows[0]!.renews).toMatchObject({ id: 3, revision: 1 });
  });

  it("the second morning (Priya's offsite): a reply that holds the question never does it, whatever part of it the model quoted as done", () => {
    const ownText = "D,\n\nMy gut says Sonoma too, but let me check the Q1 cash plan with Rae and the January board calendar before Jess holds anything. I'll get back to you.\n\nP";
    const daniel = { label: "r1", name: "Daniel Okafor", email: "daniel@lumora.io" };
    const getBack = { text: "check the Q1 cash plan with Rae and get back to Daniel", quote: "let me check the Q1 cash plan with Rae and the January board calendar before Jess holds anything. I'll get back to you.", to: "r1", due: null };
    const input = (requests: [string, { id: number; revision: number; senderKey: string }][]) => ({ ...base, ownText, recipients: [daniel], requests: new Map(requests) });
    const q1 = ["q1", { id: 7, revision: 2, senderKey: "daniel@lumora.io" }] as [string, { id: number; revision: number; senderKey: string }];
    // the panel's answer: "fulfilled" on "My gut says Sonoma too": held by the promise, not done
    expect(checkSentMail({ promises: [getBack], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "My gut says Sonoma too" }] }, input([q1])).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
    // someone else's request is theirs to answer: done stays done
    expect(checkSentMail({ promises: [getBack], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "My gut says Sonoma too" }] }, input([["q1", { id: 7, revision: 2, senderKey: "rae@lumora.io" }]])).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    // two of Daniel's: one done, the other held by its own verdict, as the model said
    expect(checkSentMail({ promises: [getBack], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "My gut says Sonoma too" }, { label: "q2", verdict: "holding", evidence: "I'll get back to you" }] }, input([q1, ["q2", { id: 8, revision: 0, senderKey: "daniel@lumora.io" }]])).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }, { request: { id: 8, revision: 0 }, verdict: "holding", item: 0 }]);
    // no promise that only holds: done is done
    expect(checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "My gut says Sonoma too" }] }, input([q1])).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    // the replay's María: the head count given in its own paragraph is done; "I'll let you know Monday if I'm working
    // Thursday", another paragraph's, holds nothing of it
    const maria = "Hey E,\n\nOk numbers: me, Chris, Sofia, Mateo, and yes Chris's mom is coming this year. So 5 of us.\n\nThe new schedule posts Monday, so I'll let you know Monday if I'm working Thursday.\n\nMaria";
    const monday = { text: "let Elena know whether you're working Thursday", quote: "The new schedule posts Monday, so I'll let you know Monday if I'm working Thursday.", to: "r1", due: "2026-11-16" };
    expect(checkSentMail({ promises: [monday], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "me, Chris, Sofia, Mateo, and yes Chris's mom is coming this year." }] }, { ...base, ownText: maria, recipients: [{ label: "r1", name: "Elena Ruiz", email: "elena@ruiz.test" }], requests: new Map([["q1", { id: 7, revision: 2, senderKey: "elena@ruiz.test" }]]) }).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
  });

  it("the second morning's code review: a holding promise holds a done request only when it qualifies it (its sentence, or a thing named in both), never by its paragraph alone", () => {
    const elena = { label: "r1", name: "Elena Ruiz", email: "elena@ruiz.test" };
    const headcount = new Map([["q1", { id: 7, revision: 2, senderKey: "elena@ruiz.test", text: "Tell Elena how many of you are coming for Thanksgiving" }]]);
    const read = (ownText: string, promise: SentMailResult["promises"][number], evidence: string, requests = headcount) => checkSentMail({ promises: [promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence }] }, { ...base, ownText, recipients: [elena], requests }).verdicts;
    // the head count, and a promise about her shift in the same paragraph: done
    const monday = { text: "let Elena know whether you're working Thursday", quote: "I'll let you know Monday if I'm working Thursday.", to: "r1", due: "2026-11-16" };
    expect(read("Hey E,\n\nThere will be five of us. I'll let you know Monday if I'm working Thursday.\n\nMaria", monday, "There will be five of us.")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    // the same in Spanish
    const lunes = { text: "avisarle a Elena si trabajas el jueves", quote: "Te aviso el lunes si me toca trabajar el jueves.", to: "r1", due: "2026-11-16" };
    expect(read("Hola E,\n\nSomos cinco. Te aviso el lunes si me toca trabajar el jueves.\n\nMaría", lunes, "Somos cinco.")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }]);
    // one about the head count itself, in another sentence: held
    const count = { text: "confirm with Chris's mom how many of you are coming and tell Elena", quote: "I'll check with Chris's mom and let you know how many are coming.", to: "r1", due: null };
    expect(read("Hey E,\n\nProbably five of us. I'll check with Chris's mom and let you know how many are coming.\n\nMaria", count, "Probably five of us.")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
  });

  it("a promise that only holds it holds it, whatever the model called it (iteration 4); a \"done\" that's a promise's words is that promise", () => {
    const ownText = "Let me check my calendar and get back to you. I'll send it Wednesday.";
    const holding = { text: "check and get back to Ms. Greer", quote: "Let me check my calendar and get back to you", to: "r1", due: null };
    const one = (verdict: "promise" | "holding" | "fulfilled", evidence: string, promises: SentMailResult["promises"] = [holding]) => checkSentMail({ promises, expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict, evidence }] }, { ...base, ownText }).verdicts;
    expect(one("holding", "Let me check my calendar and get back to you")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
    expect(one("promise", "Let me check my calendar and get back to you")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
    // a "holding" whose words send something, or with no promise of those words kept above: nothing
    expect(one("holding", "I'll send it Wednesday", [promise])).toEqual([]);
    expect(one("holding", "Let me check my calendar and get back to you", [])).toEqual([]);
    expect(checkSentMail({ promises: [holding, promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "I'll send it Wednesday" }] }, { ...base, ownText }).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "promise", item: 1 }]);
    // iteration 4 (prompt v12's eval): a promise is said to you, "your", never "my", whatever the model wrote
    expect(yourWords("send Asha my script")).toBe("send Asha your script");
    expect(yourWords("enviarle a Jess el escaneo de mi pasaporte y mis fotos")).toBe("enviarle a Jess el escaneo de tu pasaporte y tus fotos");
    expect(yourWords("My notes to Dana, para mí, drive 5 mi east")).toBe("Your notes to Dana, para mí, drive 5 mi east");
    expect(checkSentMail({ promises: [{ ...promise, text: "send Ms. Greer my slip" }], expectsReply: false, awaiting: [], kept: [], answers: [] }, base).rows[0]!.text).toBe("send Ms. Greer your slip");
    expect(onlyHolds("lo reviso y te aviso")).toBe(true);
    expect(onlyHolds("I'll check the numbers and send you the report Friday")).toBe(false);
    expect(onlyHolds("te lo mando el lunes")).toBe(false);
  });
});

describe("a promise that answers a request keeps its deadline (iteration 3)", () => {
  it("María: the school's Friday carried onto her Wednesday promise; the request no row of its own; Done finishes both, Undo restores both", async () => {
    const { backend, client, model, clock, request, reply, datedDone, followupsDone, rows, sentPrompts } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    expect(req).toMatchObject({ kind: "respond", state: "open" });
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    // the request was shown, with its day
    expect(sentPrompts().at(-1)).toContain("<requests>\nq1: Return the signed field trip slip (by 2026-11-13)\n</requests>");
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(promise).toMatchObject({ answers: req!.id, dated: true });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // Tuesday: the promise under Wednesday, saying Friday; the request isn't a row
    let list = await rows();
    expect(list.map((r) => [r.id, r.section])).toEqual([[`promise:${promise!.id}`, "day:2026-11-11"]]);
    expect(list[0]!.why.promise).toMatchObject({ needed: at(2026, 11, 13, 9) });
    // Thursday: Wednesday missed, Friday still ahead ("You said Wed 11 (missed) · needed Fri"): never Missed, and (iteration 4,
    // revision 8: the owner's "Today, Waiting on you") the school is waiting on it now, so it's first in Today's Waiting on
    // you, counted once there, no longer under Friday
    clock.now = at(2026, 11, 12, 10);
    list = await rows();
    expect(list.map((r) => [r.id, r.section])).toEqual([[`promise:${promise!.id}`, "today:waiting"]]);
    expect(list[0]!.why.promise).toMatchObject({ said: at(2026, 11, 11, 9), needed: at(2026, 11, 13, 9) });
    expect((await client.call("today.list", { held: [] })).counts).toEqual({ missed: 0, today: 0, waiting: 1, overdue: 1 });
    // Done on its row: the promise and the request together, and no history line of the request's own
    const now = (await backend.store.followups.get(promise!.id))!;
    const { undoId } = await client.call("followups.act", { id: now.id, revision: now.revision, action: "done" });
    expect(await backend.store.followups.get(promise!.id)).toMatchObject({ state: "done" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled", closedReason: "promise" });
    expect(await rows()).toEqual([]);
    const history = (await client.call("today.list", { held: [], history: { through: null } })).history!;
    expect(history.items.map((h) => h.id)).toEqual([`promise:${promise!.id}`]);
    // its Undo: both back, as they were
    await client.call("followups.undo", { undoId: undoId! });
    expect(await backend.store.followups.get(promise!.id)).toMatchObject({ state: "due" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open", closedReason: null });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
    // the second morning (Diego's adjustments): Friday's mail sends it, the model saying the request is done but keeping no
    // promise: the promise answering it is kept too, never a Missed row beside a settled request
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip.");
    await followupsDone();
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled" });
    expect(await backend.store.followups.get(promise!.id)).toMatchObject({ state: "done" });
    expect(await rows()).toEqual([]);
  });

  it("Codex code review: Done on the promise settles every reading of the request it answers (one item), and its Undo brings them all back", async () => {
    const { backend, client, model, ingest, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    // the school asks again: a second reading of the same request, made one item with the first
    const again = await ingest({ from: school, to: [me], isSent: false, inInbox: true, bodyText: SLIP, inReplyTo: asked.rfc, references: [asked.rfc] });
    expect(again.thread).toBe(asked.thread);
    await datedDone();
    const readings = (await backend.store.dated.ofThread(asked.thread)).filter((r) => r.kind === "respond");
    expect(readings).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect((await Promise.all(readings.map((r) => backend.store.dated.get(r.id)))).filter((r) => r!.sameAs !== null)).toHaveLength(1);
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(again, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(promise!.answers).not.toBeNull();
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
    const now = (await backend.store.followups.get(promise!.id))!;
    const { undoId } = await client.call("followups.act", { id: now.id, revision: now.revision, action: "done" });
    for (const r of readings) expect(await backend.store.dated.get(r.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
    await client.call("followups.undo", { undoId: undoId! });
    for (const r of readings) expect(await backend.store.dated.get(r.id)).toMatchObject({ state: "open", closedReason: null });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
  });

  it("Remove acts on the promise alone: the request is its own row again, with its day; a holding reply leaves the request the row", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    await client.call("followups.act", { id: promise!.id, revision: promise!.revision, action: "dismiss" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // (a person's request, shown from its arrival among the people: plan 210, iteration 2)
    expect((await rows()).map((r) => [r.id, r.section])).toEqual([[`dated:${req!.id}`, "today:waiting"]]);
    // Margaret: "let me check my calendar and get back to you": the request stays the row, its day kept
    const other = await request();
    await datedDone();
    const [second] = await backend.store.dated.ofThread(other.thread);
    model.sent = () => sent({ promises: [{ text: "check and get back to Ms. Greer", quote: "Let me check my calendar and get back to you", to: "r1", due: null }], answers: [{ label: "q1", verdict: "holding", evidence: "Let me check my calendar and get back to you" }] });
    await reply(other, "Let me check my calendar and get back to you.");
    await followupsDone();
    expect(await backend.store.dated.get(second!.id)).toMatchObject({ state: "open" });
    expect((await backend.store.followups.ofThread(other.thread)).every((p) => p.answers == null)).toBe(true);
    expect((await rows()).some((r) => r.id === `dated:${second!.id}`)).toBe(true);
  });

  it("iteration 4: Margaret's \"I'll check my calendar and get back to you\" is stored with the request it holds, and no row while it stands; it ends with the request, with no line of its own", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [{ text: "check your calendar and get back to Ms. Greer", quote: "I need to look at my calendar and will get back to you", to: "r1", due: null }], answers: [{ label: "q1", verdict: "holding", evidence: "I need to look at my calendar and will get back to you" }] });
    await reply(asked, "I need to look at my calendar and will get back to you.");
    await followupsDone();
    const [hold] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(hold).toMatchObject({ holds: req!.id, answers: null });
    // the request is the row, never the hold, even once the hold comes due
    expect((await rows()).map((r) => r.id)).toEqual([`dated:${req!.id}`]);
    await backend.store.followups.makeDue(hold!.dueAt + 1);
    expect((await rows()).map((r) => r.id)).toEqual([`dated:${req!.id}`]);
    // the request done: the hold ends with it, its line the request's
    const now = (await backend.store.dated.get(req!.id))!;
    await client.call("dated.act", { id: now.id, revision: now.revision, action: "done" });
    expect(await rows()).toEqual([]);
    expect(await backend.followups.retire()).toBe(1);
    expect(await backend.store.followups.get(hold!.id)).toMatchObject({ state: "dismissed", closedReason: "held" });
    const history = (await client.call("today.list", { held: [], history: { through: null } })).history!;
    expect(history.items.map((h) => h.id)).toEqual([`dated:${req!.id}`]);
  });

  it("done now (\"here's the slip\") settles the request; a send alone, follow-ups off, or a failed reading settles nothing", async () => {
    const { backend, client, clock, model, request, reply, datedDone, followupsDone } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    // a reading that fails: nothing changes
    model.sent = () => ({ text: "not json", stop: "end" });
    await reply(asked, "Here's the signed slip.");
    await followupsDone();
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // follow-ups off: a reply decides nothing
    await client.call("settings.update", { followups: { enabled: false } });
    await reply(asked, "Here's the signed slip again.");
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // on, and its verdict: done
    await client.call("settings.update", { followups: { enabled: true } });
    // (what you sent before it went on again is read only with a yes)
    clock.now += 120_000;
    model.sent =() => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip, finally.");
    await followupsDone();
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled", closedReason: "answered" });
  });
});

describe("one reply, one row (iteration 4, the Codex review's revision 4)", () => {
  const green = { text: "recalibrate the green for Ms. Greer", quote: "I'll recalibrate the green first", to: "r1", due: null };

  it("a reply's promises to one person are one row; Done on it finishes every one, its duplicates and the request it answers, Undo all of them", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const promises = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    const [first, send] = promises;
    expect(send).toMatchObject({ answers: req!.id, dated: true });
    // one row, the dated one leading, the other its Also line and named for its acts
    const list = await rows();
    expect(list.map((r) => r.id)).toEqual([`promise:${send!.id}`]);
    expect(list[0]!.why.with).toEqual([{ source: "promise", id: first!.id, revision: first!.revision }]);
    expect(list[0]!.also).toMatchObject([{ kind: "promise", text: green.text, dated: false }]);
    // Done on the row: both promises and the request, at once
    const { undoId } = await client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: list[0]!.why.with! });
    for (const p of promises) expect(await backend.store.followups.get(p.id)).toMatchObject({ state: "done" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
    // Undo: every one back
    await client.call("followups.undo", { undoId: undoId! });
    for (const p of promises) expect((await backend.store.followups.get(p.id))!.state).toMatch(/open|due/);
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${send!.id}`]);
  });

  it("Mute beside it (iteration 4, merge): the sender muted, their request is hidden, never closed; your reply's promises are yours, still one row with its Also line, and its Done still finishes the request they answer", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const [first, send] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    // iteration 5: a new mute of someone you've written to is refused, so this is one from before (an Unmute's Undo puts one back)
    await client.call("dated.mute", { on: "sender", key: school.email, name: school.name, at: 0 });
    expect((await client.call("dated.ofThread", { threadId: asked.thread })).rows).toEqual([]);
    const [row] = await rows();
    expect(row).toMatchObject({ id: `promise:${send!.id}`, why: { with: [{ source: "promise", id: first!.id }] }, also: [{ text: green.text }] });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    await client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: row!.why.with! });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
  });

  it("all or none: one of them changed since it was shown, nothing is done; one acted on alone (the reader's line) leaves the row the other's", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const [first, send] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    const shown = (await rows())[0]!.why.with!;
    await expect(client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: [{ ...shown[0]!, revision: shown[0]!.revision + 1 }] })).rejects.toMatchObject({ code: "STALE" });
    expect(await backend.store.followups.get(send!.id)).toMatchObject({ state: send!.state });
    // the reader's line: the green alone; the row stays, its Also gone
    await client.call("followups.act", { id: first!.id, revision: first!.revision, action: "done" });
    expect(await backend.store.followups.get(send!.id)).toMatchObject({ state: send!.state });
    const [row] = await rows();
    expect(row).toMatchObject({ id: `promise:${send!.id}` });
    expect(row!.why.with).toBeUndefined();
    expect(row!.also).toBeUndefined();
  });
});

describe("whichever reader finishes first (revision 1)", () => {
  it("follow-ups first: your reply waits for its conversation's mail to be read, then its verdict applies", async () => {
    const { backend, model, request, reply, datedDone, followupsDone, sentPrompts } = await setup();
    let open!: () => void;
    model.datedGate = new Promise((resolve) => (open = resolve));
    model.dated = () => dated([slip]);
    const asked = await request();
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip.");
    backend.followups.wake();
    // held: not read while the request's mail is
    await new Promise((r) => setTimeout(r, 50));
    expect(await backend.store.followups.marks.count()).toBe(1);
    expect(sentPrompts()).toEqual([]);
    open();
    model.datedGate = null;
    await datedDone();
    await followupsDone();
    expect(sentPrompts()).toHaveLength(1);
    expect(sentPrompts()[0]).toContain("q1: Return the signed field trip slip");
    const all = await backend.store.dated.closedPage({ since: 0, after: null, limit: 10 });
    expect(all.map((r) => [r.kind, r.state, r.closedReason])).toEqual([["respond", "settled", "answered"]]);
  });

  it("a request read after your reply (the dated reader off then, its 14-day check now): the reply is read again for its verdict", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, sentPrompts } = await setup({ dated: false });
    const asked = await request();
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip.");
    await followupsDone();
    expect(sentPrompts()).toHaveLength(1);
    expect(sentPrompts()[0]).not.toContain("<requests>");
    await client.call("settings.update", { dated: { enabled: true } });
    model.dated = () => dated([slip]);
    await client.call("dated.scan", {});
    await datedDone();
    await followupsDone();
    expect(sentPrompts()).toHaveLength(2);
    expect(sentPrompts()[1]).toContain("q1: Return the signed field trip slip");
    expect((await backend.store.dated.closedPage({ since: 0, after: null, limit: 10 })).map((r) => [r.state, r.closedReason])).toEqual([["settled", "answered"]]);
  });
});

describe("an ask you already answered (the second morning: round 15's Hannah and Rafa)", () => {
  const answer = "Hi,\n\nWe've used Calder Valuation for our last two. Sarah Kim ran both. Two weeks start to finish.\n\nYes, I'd use them again.\n\nPriya";
  const joined = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "We've used Calder Valuation for our last two. Yes, I'd use them again." }] });
  for (const order of ["the request read first", "your reply read first", "the request read after your reply"] as const) {
    it(`${order}: the answer joined from their lines settles it`, async () => {
      const { backend, client, model, request, reply, datedDone, followupsDone, sentPrompts } = await setup({ dated: order !== "the request read after your reply" });
      let open!: () => void;
      if (order === "your reply read first") model.datedGate = new Promise((resolve) => (open = resolve));
      model.dated = () => dated([slip]);
      model.sent = joined;
      const asked = await request();
      if (order === "the request read first") await datedDone();
      await reply(asked, answer);
      if (order === "your reply read first") {
        backend.followups.wake();
        open();
        model.datedGate = null;
        await datedDone();
      }
      await followupsDone();
      if (order === "the request read after your reply") {
        await client.call("settings.update", { dated: { enabled: true } });
        await client.call("dated.scan", {});
        await datedDone();
        await followupsDone();
      }
      expect(sentPrompts().at(-1)).toContain("q1: Return the signed field trip slip");
      expect((await backend.store.dated.closedPage({ since: 0, after: null, limit: 10 })).map((r) => [r.state, r.closedReason])).toEqual([["settled", "answered"]]);
    });
  }
});

describe("a bill from someone your reply writes to (round 16: Sam's electric)", () => {
  it("is among the reply's requests and its verdict pays it; a biller's bill, its sender not written to, isn't offered", async () => {
    const { backend, model, ingest, reply, datedDone, followupsDone, sentPrompts } = await setup();
    const jonah = { name: "Jonah", email: "jonah@home.test" };
    const half = { kind: "pay", text: "Pay Jonah $48.20 for the electric bill", quote: "venmo whenever but ideally before the 20th", due: "2026-11-20", time: null };
    model.dated = () => dated([half]);
    const asked = await ingest({ from: jonah, to: [me], isSent: false, inInbox: true, subject: "electric", bodyText: "electric came in at $96.40 so your half is $48.20. venmo whenever but ideally before the 20th" });
    await datedDone();
    const [bill] = await backend.store.dated.ofThread(asked.thread);
    expect(bill).toMatchObject({ kind: "pay", state: "open" });
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "just venmo'd you the $48.20" }] });
    await reply(asked, "just venmo'd you the $48.20", { to: [jonah] });
    await followupsDone();
    expect(sentPrompts().at(-1)).toContain("<requests>\nq1: Pay Jonah $48.20 for the electric bill (by 2026-11-20)\n</requests>");
    // paid, as Earlier says it
    expect(await backend.store.dated.get(bill!.id)).toMatchObject({ state: "settled", closedReason: "settled" });
    // the utility's own bill, the reply written to Jonah: not his to be told
    const utility = { name: "City Power", email: "billing@citypower.test" };
    model.dated = () => dated([{ ...half, text: "Pay the electricity bill", quote: "Amount due $96.40 by November 20" }]);
    const statement = await ingest({ from: utility, to: [me], isSent: false, inInbox: true, subject: "Your statement", bodyText: "Amount due $96.40 by November 20." });
    await datedDone();
    expect(await backend.store.dated.ofThread(statement.thread)).toMatchObject([{ kind: "pay", state: "open" }]);
    model.sent = () => sent();
    await reply(statement, "can you cover half of this one too?", { to: [jonah] });
    await followupsDone();
    expect(sentPrompts().at(-1)).not.toContain("<requests>");
    // its code review: nor with the utility's billing address copied on a reply-all (a company's bill is paid by its receipt)
    await reply(statement, "Jonah, I paid my half of this one.", { to: [jonah], cc: [utility] });
    await followupsDone();
    expect(sentPrompts().at(-1)).not.toContain("<requests>");
  });

  it("its code review: a bill is settled only by your saying it's paid, never by a promise to, a denial or a condition (en, es)", () => {
    const requests = new Map([["q1", { id: 7, revision: 2, kind: "pay" as const, senderKey: "jonah@home.test", text: "Pay Jonah $48.20 for the electric bill" }]]);
    const input = (ownText: string) => ({ ownText, recipients: [{ label: "r1", name: "Jonah", email: "jonah@home.test" }], open: new Map(), requests, sentAt: NOW, nudgeAfterDays: 5 });
    const done = (ownText: string, evidence = ownText) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence }] }, input(ownText)).verdicts;
    const paid = [{ request: { id: 7, revision: 2 }, verdict: "fulfilled" }];
    for (const yes of ["just venmo'd you the $48.20", "Paid you back for the electric.", "I sent you the $48.20 on Zelle.", "Ya te pagué los $48.20.", "Te transferí lo de la luz."]) expect(done(yes), yes).toEqual(paid);
    for (const no of ["I have not paid the $48.20 yet.", "I haven't paid the electric yet.", "I will have paid you by Friday.", "If I paid you twice, tell me.", "Todavía no te pagué lo de la luz.", "Cuando te pague te aviso.", "Thanks for the electric numbers!"]) expect(done(no), no).toEqual([]);
    // a promise to pay it links nothing: the bill keeps its own row
    const promise = { text: "venmo Jonah the $48.20", quote: "I'll venmo you Sunday", to: "r1", due: "2026-11-15", partOfDay: null };
    for (const verdict of ["promise", "fulfilled", "holding"] as const) expect(checkSentMail({ promises: [promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict, evidence: "I'll venmo you Sunday" }] }, input("I'll venmo you Sunday.")).verdicts).toEqual([]);
  });
});

describe("a promise past its day retires (revision 7)", () => {
  it("its Missed week over, from the day it sits under: one whose request is still ahead stays", async () => {
    const { backend, clock, model, request, reply, datedDone, followupsDone } = await setup();
    model.dated = () => dated([{ ...slip, due: "2026-11-27", quote: "return the signed field trip slip by Friday" }]);
    const asked = await request();
    await datedDone();
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    // another promise, answering nothing
    model.sent = () => sent({ promises: [{ text: "call Ms. Greer", quote: "I'll call you Wednesday", to: "r1", due: "2026-11-11" }] });
    const lone = await request();
    await reply(lone, "I'll call you Wednesday.");
    await followupsDone();
    const answering = (await backend.store.followups.ofThread(asked.thread)).find((p) => p.kind === "promise")!;
    const alone = (await backend.store.followups.ofThread(lone.thread)).find((p) => p.kind === "promise")!;
    expect(answering.answers).not.toBeNull();
    // Wednesday 18th: Wednesday 11th's Missed week is over; the request's Friday 27th is ahead
    clock.now = at(2026, 11, 19, 10);
    expect(await backend.followups.retire()).toBe(1);
    expect(await backend.store.followups.get(alone.id)).toMatchObject({ state: "dismissed", closedReason: "expired" });
    expect((await backend.store.followups.get(answering.id))!.closedReason).toBeNull();
  });
});
