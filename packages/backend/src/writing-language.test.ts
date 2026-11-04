/**
 * Which language a draft is in, per account and person, through the real backend and a scripted model: someone may
 * write one language from one account or to one person, and another elsewhere, in any combination.
 */
import type { CompletionRequest } from "@terno/ai";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, setup, START, textOf, TOM } from "./test/writing-fixture";

afterEach(cleanUp);

const ES = "Hola, gracias por el correo. Te escribo para que me digas cómo va todo con el contrato.";
const EN = "Thanks for the update, please send it to me and we will have a look at it with the team.";
const FR = "Bonjour, merci pour votre message. Nous pouvons nous voir dans la semaine avec plaisir.";

const last = (t: { model: { requests: CompletionRequest[] } }) => t.model.requests[t.model.requests.length - 1]!;
const done = async <T extends { status: string }>(p: Promise<T>) => {
  const r = await p;
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}`);
  return r as Extract<T, { status: "done" }>;
};
const taskOf = (t: { model: { requests: CompletionRequest[] } }) => /<task>[\s\S]*<\/task>/.exec(textOf(last(t)))![0];

describe("the language of a draft", () => {
  it("keeps a settled habit with this person when they write in another language", async () => {
    const t = await setup();
    await t.sentMany(6, (i) => ({ bodyText: `${ES} ${i}`, date: START - 86_400_000 * (i + 1) }));
    await t.learned();
    const { thread } = await t.received({ bodyText: EN });
    const r = await done(t.compose({ kind: "reply", threadId: thread }));
    expect(r.used).toMatchObject({ language: "es", languageReason: "person" });
    expect(taskOf(t)).toContain("language: Spanish");
  });

  it("follows the other person when the history with them is mixed", async () => {
    const t = await setup();
    await t.sentMany(6, (i) => ({ bodyText: `${i % 2 ? ES : EN} ${i}`, date: START - 86_400_000 * (i + 1) }));
    await t.learned();
    const { thread } = await t.received({ bodyText: FR });
    const r = await done(t.compose({ kind: "reply", threadId: thread }));
    expect(r.used).toMatchObject({ language: "fr", languageReason: "inbound" });
    expect(taskOf(t)).toContain("language: French");
  });

  it("a new message to someone new follows how this account writes, not the instruction's language", async () => {
    const t = await setup();
    await t.sentMany(20, (i) => ({ to: [{ name: "Ana", email: `p${i % 4}@else.test` }], bodyText: `${EN} ${i}` }));
    await t.learned();
    const r = await done(t.compose({ to: [{ name: "New", email: "new@consumer.test" }], instruction: "dile que el martes no puedo ir a la reunión" }));
    expect(r.used.language).toBe("en");
    expect(["account", "domain"]).toContain(r.used.languageReason);
    expect(taskOf(t)).toContain("language: English");
  });

  it("a person written to from this account in one language and to others in another", async () => {
    const t = await setup();
    await t.sentMany(20, (i) => ({ to: [{ name: "Ana", email: `p${i % 4}@else.test` }], bodyText: `${EN} ${i}` }));
    await t.sentMany(5, (i) => ({ bodyText: `${FR} ${i}` }));
    await t.learned();
    const r = await done(t.compose({ to: [TOM], instruction: "say that works" }));
    expect(r.used).toMatchObject({ language: "fr", languageReason: "person" });
  });

  it("an instruction naming a language wins", async () => {
    const t = await setup();
    await t.sentMany(6, (i) => ({ bodyText: `${ES} ${i}` }));
    await t.learned();
    const first = await done(t.compose({ to: [TOM], instruction: "say that works, in English" }));
    expect(first.used).toMatchObject({ language: "en", languageReason: "asked" });
    expect(taskOf(t)).toContain("language: English");
  });

  it("another language's greeting doesn't reach the prompt", async () => {
    const t = await setup();
    await t.sentMany(8, (i) => ({ bodyText: `Hi Tom,\n\n${EN} ${i}\n\nBest,\nLuis` }));
    await t.learned();
    const { thread } = await t.received({ bodyText: ES, subject: "Una consulta" });
    await done(t.compose({ kind: "reply", threadId: thread, instruction: "dile que sí, en español" }));
    const voice = textOf(last(t)).split("<task>")[0]!;
    expect(/opens with:[^\n]*Hi \{name/.test(voice)).toBe(false);
  });
});
