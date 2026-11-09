import { createAi, digestPrompt, probe, type AiTasks, type ProviderConfig } from "@terno/ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anchor, answerFor, startModelStub, type ModelStub } from "../../../scripts/ui-rating/model-stub.mjs";
import { checkSentMail } from "./followups";

/**
 * Plan 161: the rating's model stand-in answers every task the app sends, through the real Ollama transport (HTTP,
 * SSE) and each task's own validator, so an answer that wouldn't render fails here rather than in a capture.
 */
let stub: ModelStub;
let ai: AiTasks;
const config = (url: string): ProviderConfig => ({ id: "ollama", model: "qwen3:8b", baseURL: `${url}/v1`, apiKey: null, fetch: globalThis.fetch, timeoutMs: 20_000, maxRetries: 0, capabilities: { output: "json_schema", contextTokens: 40_960, embeddings: false, probedAt: 1 } });
const signal = () => new AbortController().signal;
/** each task asked once: an answer the validator sent back for repair would show as a second request */
const asked = (task: string) => stub.tasks.filter((t) => t === task).length;

beforeAll(async () => {
  stub = await startModelStub();
  ai = createAi(config(stub.url));
});
afterAll(() => stub.close());

const THREAD = [
  { label: "m101", from: "Isabella Torres <isabella.torres@gmail.com>", date: "2026-10-20", own: false, text: "Hola Luis,\n\nTe comparto la información que platicamos ayer en la reunión. El cliente pidió algunos cambios en la sección de precios.\n\nSaludos,\nIsabella" },
  { label: "m102", from: "Luis Cordero <luis@acme.studio>", date: "2026-10-21", own: true, text: "Isabella,\n\nGracias, lo veo hoy.\n\nAbrazo,\nLuis" },
  { label: "m103", from: "Isabella Torres <isabella.torres@gmail.com>", date: "2026-10-22", own: false, text: "Hola Luis,\n\nHubo un problema con el pago, ¿lo puedes revisar? ¿Tienes disponibilidad el jueves para una llamada rápida?\n\nGracias,\nIsabella\n\n> Isabella,\n> Gracias, lo veo hoy." },
];

describe("the model stub (plan 161)", () => {
  it("passes Test connection with structured output, and lists its models as Ollama does", async () => {
    const result = await probe(config(stub.url), signal());
    expect(result.capabilities).toMatchObject({ output: "json_schema", contextTokens: 40_960 });
    expect(stub.requests).toEqual(expect.arrayContaining(["GET /api/tags", "POST /api/show"]));
  });

  it("summarizes from the request: the sender's name, real dates, items citing the message that asks, accepted first time", async () => {
    const before = asked("thread_summary");
    const result = await ai.summarize({ subject: "Ajustes de precios", thread: THREAD, reader: { name: "Luis Cordero", email: "luis@acme.studio" }, language: "en", today: "2026-10-22" }, signal());
    expect(asked("thread_summary") - before).toBe(1);
    expect(result.summary).toMatch(/^Isabella reports a problem with the payment on 22 October\./);
    expect(result.summary).toContain("Before that, Isabella shared the notes from the meeting on Monday 19 October.");
    expect(result.summary).toContain("You last wrote on 21 October.");
    expect(result.items).toEqual([
      { kind: "action", text: "Check what went wrong with the payment", message: "m103" },
      { kind: "question", text: "Are you free for a quick call on Thursday 29 October?", message: "m103" },
    ]);
  });

  it("drafts with ⌘J as a stream: the instruction in the author's words, greeted by first name, signed as they sign", async () => {
    const deltas: string[] = [];
    const result = await ai.compose(
      {
        sender: { name: "Luis Cordero", address: "luis@acme.studio" },
        signature: null,
        instructions: [],
        voice: [{ scope: "you", text: 'opens with: "Hi" 70%\ncloses with: "Abrazo," 80%', fromOtherAccount: false }],
        messagesToPerson: [],
        pastConversations: [],
        thread: THREAD.map(({ from, date, own, text }) => ({ from, date, own, text })),
        subject: "Ajustes de precios",
        task: { kind: "reply", today: "2026-10-22", timezone: "UTC", recipients: ["Isabella Torres <isabella.torres@gmail.com>"], instruction: "say yes, thursday at 4 works, and ask her to send the receipt", needsSubject: false },
      },
      { onDelta: (t) => deltas.push(t), signal: signal() },
    );
    expect(deltas.length).toBeGreaterThan(3);
    expect(result.text).toBe("Hi Isabella,\n\nYes. Thursday at 4 works. Could you send the receipt?\n\nAbrazo,\nLuis");
    expect(result.subject).toBeNull();
  });

  it("plan 163: fills a draft's gaps as a stream, from what the thread says; a fact it doesn't hold stays empty", async () => {
    const fills: [number, string, boolean][] = [];
    const result = await ai.fill(
      {
        sender: { name: "Luis Cordero", address: "luis@acme.studio" },
        signature: null,
        instructions: [],
        voice: [],
        messagesToPerson: [],
        pastConversations: [],
        thread: THREAD.map(({ from, date, own, text }) => ({ from, date, own, text })),
        subject: "Ajustes de precios",
        task: { kind: "reply", today: "2026-10-22", timezone: "UTC", recipients: ["Isabella Torres <isabella.torres@gmail.com>"], instruction: "", needsSubject: false, fill: [{ text: "Hi Isabella, the call works on " }, { gap: 1, text: "[day of the call]" }, { text: ", and the flat is at " }, { gap: 2, text: "[address]" }, { text: ". " }, { gap: 3, text: "[something nice about the meeting]" }] },
      },
      { onFill: (n, t, done) => fills.push([n, t, done]), signal: signal() },
    );
    expect(result.fills).toEqual(["Thursday 29 October", "", "thanks again for all your help"]);
    expect(fills.filter(([, , done]) => done).map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it("plan 163: reads what was typed, in shape: an instruction or an email, and which marked spots are gaps", async () => {
    expect(await ai.readDraft({ text: "sounds good, see you friday", maybe: [] }, signal())).toEqual({ kind: "instruction", gaps: [] });
    expect(await ai.readDraft({ text: "Hi Isabella,\nsee you … at the office, well... ok", maybe: [{ from: 21, to: 22 }] }, signal())).toEqual({ kind: "email", gaps: [0] });
  });

  it("Ask: plans searches the store can match, then answers cited with the labels it was given", async () => {
    const plan = await ai.planAsk({ question: "What did Isabella say about the payment?", today: "2026-10-22", timezone: "UTC", accounts: [{ name: "Luis", address: "luis@acme.studio" }], categories: [] }, signal());
    expect(plan.kind).toBe("question");
    expect(plan.queries[0]).toMatchObject({ from: "Isabella" });
    expect(plan.queries[1]?.anyOf).toEqual([["payment", "pago", "pay", "paid"]]);
    const material = THREAD.map((m, i) => ({ label: `m${i + 1}`, from: m.from, date: m.date, subject: "Ajustes de precios", own: m.own, text: m.text }));
    const deltas: string[] = [];
    const result = await ai.answerFromMail({ question: "What did Isabella say about the payment?", today: "2026-10-22", material }, { onDelta: (t) => deltas.push(t), signal: signal() });
    expect(result.status).toBe("answered");
    expect(result.text).toBe("On 22 October, Isabella reports a problem with the payment and asks you to look into it [m3].");
    expect(deltas.length).toBeGreaterThan(1);
    const commanded = await ai.planAsk({ question: "Archive shipping notices older than a month", today: "2026-10-22", timezone: "UTC", accounts: [], categories: [] }, signal());
    expect(commanded.kind).toBe("command");
  });

  it("actions in plain English: a rule the converter accepts, and a check that drops only what doesn't fit", async () => {
    const plan = await ai.planAction({ sentence: "Archive shipping notices older than a month", today: "2026-10-22", timezone: "UTC", accounts: [{ id: 1, email: "luis@acme.studio", displayName: "Work" }], categories: [{ id: 3, name: "Lecturas" }], folders: [], now: Date.UTC(2026, 9, 22) }, signal());
    expect(plan).toMatchObject({ action: { type: "archive" }, lookIn: "inbox", future: false, meaning: true });
    expect(plan!.conditions.map((c) => c.field)).toEqual(["opening", "ageDays"]);
    const drop = await ai.checkCandidates({ sentence: "Archive shipping notices older than a month", groups: [{ label: "g1", name: "Amazon", domain: "amazon.com.mx", subject: "Tu pedido # ha sido enviado", count: 4 }, { label: "g2", name: "BBVA", domain: "bbva.mx", subject: "Cargo por $# en tu tarjeta", count: 2 }] }, { outputTokens: 3000, budget: { left: 5 }, signal: signal() });
    expect(drop).toEqual(["g2"]);
  });

  it("follow-ups: a question waits on its recipients, a promise quotes the sender's own words, and both survive the app's check", async () => {
    const ownText = "Hi Marta,\n\nCould you send me the signed contract? I'll share the numbers from finance on Friday.\n\nBest,\nLuis";
    const result = await ai.readSentMail({ ownText, subject: "Signed contract", recipients: [{ label: "r1", name: "Marta Ruiz" }], attachments: [], openPromises: [], sentAt: "Thursday 22 October 2026 at 15:30", language: "en" }, signal());
    expect(result).toMatchObject({ expectsReply: true, awaiting: ["r1"], promises: [{ text: "share the numbers from finance", due: "2026-10-23", to: "r1" }] });
    const { rows } = checkSentMail(result, { ownText, recipients: [{ label: "r1", name: "Marta Ruiz", email: "marta.ruiz@example.com" }], open: new Map(), sentAt: Date.UTC(2026, 9, 22, 15, 30), nudgeAfterDays: 3 });
    expect(rows.map((r) => r.kind).sort()).toEqual(["awaiting", "promise"]);
  });

  it("reply ready: mail that asks wants an answer, and the prepared draft leaves the decision to the author", async () => {
    expect(await ai.needsReply({ from: "Isabella Torres <isabella.torres@gmail.com>", subject: "Ajustes", newest: "Hubo un problema con el pago, ¿lo puedes revisar?" }, signal())).toBe(true);
    expect(await ai.needsReply({ from: "Isabella Torres <isabella.torres@gmail.com>", subject: "Ajustes", newest: "Gracias, todo listo." }, signal())).toBe(false);
    const result = await ai.compose(
      { sender: { name: "Luis Cordero", address: "luis@acme.studio" }, signature: null, instructions: [], voice: [], messagesToPerson: [], pastConversations: [], thread: THREAD.map(({ from, date, own, text }) => ({ from, date, own, text })), subject: "Ajustes", task: { kind: "reply", today: "2026-10-22", timezone: "UTC", recipients: ["Isabella Torres"], instruction: "Answer what the thread needs, as far as the mail lets you. Don't accept, decline.", needsSubject: false } },
      { onDelta: () => {}, signal: signal() },
    );
    expect(result.text).toBe("Hola Isabella,\n\n[Si puedes revisar el pago y cuándo.] [Si puedes el jueves y a qué hora.]\n\nSaludos,\nLuis");
  });

  it("the digest: newsletters get the point of the issue in at most 14 words; everything else is other", async () => {
    const items = [
      { label: "d1", from: "Morning Brew <crew@morningbrew.com>", subject: "The big story: interest rates", text: "This week: interest rates. Following up on our conversation from yesterday.\n\nUnsubscribe: https://daily.morningbrew.com/u" },
      { label: "d2", from: "Uber <uber.receipts@uber.com>", subject: "Your receipt from Uber #123", text: "Thanks for your payment. Amount: $12.00. Invoice #123." },
    ];
    expect(digestPrompt({ items, language: "English" })).toContain('<mail id="d1">');
    const out = await ai.digestNewsletters({ items, language: "English" }, signal());
    expect(out).toEqual([
      { label: "d1", kind: "newsletter", line: "Markets expect interest rates to stay high longer than hoped." },
      { label: "d2", kind: "other", line: "" },
    ]);
    expect(out[0]!.line.split(/\s+/).length).toBeLessThanOrEqual(14);
  });

  it("Create a filter with AI: a rule the converter accepts, named and explained in the request's language", async () => {
    const ctx = { now: Date.UTC(2026, 9, 22), accounts: [{ id: 1, email: "luis@acme.studio", displayName: "Work" }], categories: [{ id: 2, name: "Facturas" }] };
    const es = await ai.generateFilter("archiva los recibos de uber.com", ctx, signal());
    expect(es).toMatchObject({ name: "Recibos de Uber", explanation: "Archiva los recibos de uber.com." });
    expect(es.rule).toEqual({ match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "archive" }] });
    const en = await ai.generateFilter("archive receipts from uber.com", ctx, signal());
    expect(en).toMatchObject({ name: "Uber receipts", explanation: "Archive receipts from uber.com." });
  });

  it("the tasks no rated screen reaches still answer in shape: who an instruction is for, a manner, a label", async () => {
    expect(await ai.parseIntent({ instruction: "tell Ana the review moved", candidates: [{ id: "c1", name: "Ana Ruiz" }, { id: "c2", name: "Mark Lee" }] }, signal())).toEqual({ recipient: "c1" });
    const judged = await ai.judgeVoice({ scope: "you", language: "en", sample: [{ text: "Sounds good, see you then.", to: ["a@example.com"] } as never] }, signal());
    expect(judged.judgment.notes.length).toBeGreaterThan(0);
    expect(await ai.classify({ instructions: "", labels: ["Facturas"], items: [{ id: "1", text: "Tu factura de Uber" }] }, signal())).toEqual([{ id: "1", label: "Facturas", confidence: 0.9 }]);
  });

  it("is deterministic, and a task it doesn't know is a loud 500 rather than a filter", async () => {
    const body = { model: "qwen3:8b", messages: [{ role: "system", content: "You summarize one email conversation for the person reading it.\n\nWrite in English." }, { role: "user", content: `<subject>x</subject>\n\n<message id="m1" from="Ana <a@b.c>" date="2026-10-22">\nHi Luis,\n\nLet me know what you think.\n\nBest,\nAna\n</message>` }], response_format: { type: "json_schema", json_schema: { name: "thread_summary" } } };
    expect(JSON.stringify(answerFor(body))).toBe(JSON.stringify(answerFor(structuredClone(body))));
    const res = await fetch(`${stub.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "qwen3:8b", messages: [{ role: "system", content: "Something new." }, { role: "user", content: "hi" }] }) });
    expect(res.status).toBe(500);
    expect(stub.unknown).toEqual(["Something new."]);
  });

  it("mail it doesn't know is quoted with its relative days as dates, so the validator takes it first time", async () => {
    const before = asked("thread_summary");
    const text = "Hi Luis,\n\nThe launch moved again. Could you review the proposal next week? Let's talk tonight or this weekend, or on Friday.\n\nBest,\nAna";
    const result = await ai.summarize({ subject: "Launch", thread: [{ label: "m1", from: "Ana Ruiz <ana@x.y>", date: "2026-10-22", own: false, text }], language: "en", today: "2026-10-22" }, signal());
    expect(asked("thread_summary") - before).toBe(1);
    expect(result.summary).toBe("Ana wrote on 22 October: “The launch moved again.”");
    expect(result.items).toEqual([{ kind: "question", text: "Could you review the proposal the week of 26 October?", message: "m1" }]);
  });

  it("anchors a weekday with an hour, an unaccented one, and leaves a dated one alone", () => {
    const thursday = Date.UTC(2026, 9, 22, 12);
    expect(anchor("next Monday 9am works", thursday)).toBe("Monday 26 October 9am works");
    expect(anchor("Friday 23 October is fine", thursday)).toBe("Friday 23 October is fine");
    expect(anchor("nos vemos el próximo miercoles", thursday)).toBe("nos vemos el miércoles 28 de octubre");
    expect(anchor("el sabado o el sábado 24", thursday)).toBe("el sábado 24 de octubre o el sábado 24");
  });

  it("a summary cancelled while held doesn't use up a failure meant for the next one", async () => {
    let release!: () => void;
    const failures = [503];
    const held = await startModelStub({ chatHeld: new Promise<void>((r) => (release = r)), summaryFails: () => failures.shift() ?? null });
    try {
      const body = JSON.stringify({ model: "qwen3:8b", messages: [{ role: "system", content: "You summarize one email conversation" }, { role: "user", content: "<subject>x</subject>" }], response_format: { type: "json_schema", json_schema: { name: "thread_summary" } } });
      const controller = new AbortController();
      const cancelled = fetch(`${held.url}/v1/chat/completions`, { method: "POST", body, signal: controller.signal });
      await expect.poll(() => held.active).toBe(1);
      controller.abort();
      await expect(cancelled).rejects.toThrow();
      // the server has seen the first go before the second arrives
      await expect.poll(() => held.active).toBe(0);
      const next = fetch(`${held.url}/v1/chat/completions`, { method: "POST", body });
      await expect.poll(() => held.active).toBe(1);
      release();
      expect((await next).status).toBe(503);
      expect(held.summaries).toHaveLength(2);
    } finally {
      await held.close();
    }
  });

  it("a request cancelled while it's held is never answered, and isn't counted as running", async () => {
    let release!: () => void;
    const held = await startModelStub({ chatHeld: new Promise<void>((r) => (release = r)) });
    try {
      const controller = new AbortController();
      const asking = fetch(`${held.url}/v1/chat/completions`, { method: "POST", signal: controller.signal, body: JSON.stringify({ model: "qwen3:8b", stream: true, messages: [{ role: "system", content: "You write email for one person" }, { role: "user", content: "<task>\nkind: new\n</task>" }] }) });
      await expect.poll(() => held.active).toBe(1);
      controller.abort();
      await expect(asking).rejects.toThrow();
      await expect.poll(() => held.active).toBe(0);
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(held.active).toBe(0);
      expect(held.tasks).toEqual(["compose"]);
    } finally {
      await held.close();
    }
  });

  it("a cancelled stream stops being written", async () => {
    const controller = new AbortController();
    const slow = await startModelStub({ paceMs: 30 });
    try {
      const run = createAi(config(slow.url)).compose(
        { sender: { name: "Luis", address: "l@x.y" }, signature: null, instructions: [], voice: [], messagesToPerson: [], pastConversations: [], thread: [], subject: null, task: { kind: "new", today: "2026-10-22", timezone: "UTC", recipients: ["Ana"], instruction: "tell her the review moved to Friday afternoon", needsSubject: true } },
        { onDelta: () => controller.abort(), signal: controller.signal },
      );
      await expect(run).rejects.toMatchObject({ kind: "cancelled" });
    } finally {
      await slow.close();
    }
  });
});
