/**
 * What a first run on a real mailbox found (plan 133), through the real backend with a scripted model and invented mail:
 * a sales campaign outnumbers someone's real mail, their signature is typed in by another client, a legal footer is
 * longer than the mail above it, and one small account writes nothing like the big one.
 */
import type { CompletionRequest } from "@terno/ai";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, setup, START, textOf, TOM } from "./test/writing-fixture";

afterEach(cleanUp);

const last = (t: { model: { requests: CompletionRequest[] } }) => t.model.requests[t.model.requests.length - 1]!;
const day = 86_400_000;
const PITCH = "Our platform helps legal teams find verifiable citations in minutes instead of hours, and it drafts documents from the case law your team already relies on every single day of the week, so nobody has to spend a whole afternoon looking for one judgment.";
const SIGNATURE = "Ana Ejemplo Ejemplar\nFounder of Ejemplo Inc";
const REPLY = (i: number) => `Hi Tom,\n\nThat works for me, number ${i}.\n\nThanks,\n${SIGNATURE}`;

async function campaign(t: Awaited<ReturnType<typeof setup>>, n = 30) {
  await t.sentMany(n, (i) => ({ to: [{ name: `Lead ${i}`, email: `lead${i}@cold${i}.test` }], bodyText: `Dear Lead${i},\n\n${PITCH}\n\nSincerely,\nAna Ejemplo\nCEO Ejemplo`, date: START - day * (i + 1) }));
}

describe("a real mailbox", () => {
  it("a sales campaign isn't how someone writes: not in their length, greeting, phrases or examples", async () => {
    const t = await setup();
    await campaign(t);
    await t.sentMany(10, (i) => ({ bodyText: REPLY(i), date: START - day * (i + 40) }));
    await t.sent({ to: [{ name: "Lead 1", email: "lead1@cold1.test" }], bodyText: "Yes, Friday is fine.\n\nThanks,\nAna", date: START - day });
    await t.learned();
    await t.compose({ to: [{ name: "Lead 1", email: "lead1@cold1.test" }] });
    const prompt = textOf(last(t)).replace(/\n<past_conversations>\n[\s\S]*?\n<\/past_conversations>/, "");
    expect(prompt).not.toContain("verifiable citations");
    expect(prompt).not.toContain("Dear {name}");
    expect(prompt).not.toContain("Sincerely");
    expect(prompt).toContain('"Hi {name},"');
    expect(prompt).toContain("Yes, Friday is fine.");
    const { items } = await t.client.call("writing.profiles.list", { scope: "account", limit: 10 });
    expect(items[0]!.samples).toBe(11);
  });

  it("learns the signature block on most of their mail and asks for it", async () => {
    const t = await setup();
    await campaign(t);
    await t.sentMany(10, (i) => ({ bodyText: REPLY(i), date: START - day * (i + 40) }));
    await t.learned();
    await t.compose({ to: [{ name: "New", email: "new@else.test" }] });
    const prompt = textOf(last(t));
    expect(prompt).toContain('signs with: "Ana Ejemplo Ejemplar / Founder of Ejemplo Inc" 100%');
    expect(prompt).toContain('"Thanks,"');
    expect(prompt).not.toContain('phrases they reuse: "Founder of Ejemplo Inc"');
  });

  it("a signature set in the app is the one the model is told is added", async () => {
    const t = await setup();
    await t.client.call("accounts.update", { id: t.account.id, signature: SIGNATURE });
    await t.sentMany(10, (i) => ({ bodyText: REPLY(i), date: START - day * (i + 1) }));
    await t.learned();
    await t.compose({ to: [{ name: "New", email: "new@else.test" }] });
    const prompt = textOf(last(t));
    expect(prompt).toContain(`<signature>\n${SIGNATURE}\n</signature>`);
    expect(prompt).not.toContain("signs with:");
  });

  it("a small account has its own voice, and no other account's signature", async () => {
    const t = await setup({ accounts: 2 });
    const [work, personal] = t.accounts;
    await t.sentMany(30, (i) => ({ accountId: work!.id, to: [{ name: "C", email: `c${i % 6}@client.test` }], bodyText: `Estimado Cliente,\n\nLe confirmo lo que conversamos sobre el contrato ${i}.\n\nAtentamente,\n${SIGNATURE}`, date: START - day * (i + 1) }));
    await t.sentMany(6, (i) => ({ accountId: personal!.id, to: [{ name: "M", email: `m${i}@shop.test` }], bodyText: `hola como cancelo mi plan ${i}`, date: START - day * (i + 1) }));
    await t.learned();
    await t.compose({ accountId: personal!.id, to: [{ name: "New", email: "new@shop2.test" }], instruction: "pregunta como cancelo" });
    const prompt = textOf(last(t));
    expect(prompt).toContain('<voice scope="account">');
    expect(prompt).toContain("lowercase");
    expect(prompt).not.toContain("signs with:");
    expect(prompt).not.toContain("Founder of Ejemplo");
  });

  it("a forward with nothing typed above it says nothing about how they write", async () => {
    const t = await setup();
    await t.sentMany(6, (i) => ({ bodyText: `Sounds good to me, thanks for letting me know about ${i}.`, date: START - day * (i + 1) }));
    await t.sentMany(10, (i) => ({ subject: `Fwd: bill ${i}`, bodyText: `---------- Forwarded message ---------\nFrom: Shop <s@shop.test>\nYour bill ${i}`, date: START - day * (i + 10) }));
    await t.learned();
    const { items } = await t.client.call("writing.profiles.list", { scope: "account", limit: 10 });
    expect(items[0]!.samples).toBe(6);
  });

  it("a legal footer in another language doesn't choose the reply's language", async () => {
    const t = await setup();
    const footer = "This email and any files transmitted with it are confidential and intended for the use of the addressee. If you have received this email in error please notify the sender and delete it from your system.";
    const { thread } = await t.received({ bodyText: `Buen día Ana\n\nQuería consultarle si le queda la grabación de la sesión con el equipo?\n\nMuchas gracias.\nSaludos,\n\nPaula Ejemplo\nLegal Operations\n\n${footer}` });
    const r = await t.compose({ kind: "reply", threadId: thread, to: [TOM] });
    expect(r.status === "done" && r.used).toMatchObject({ language: "es", languageReason: "inbound" });
  });

  it("a campaign to someone doesn't make their reply's language", async () => {
    const t = await setup();
    await t.sentMany(30, (i) => ({ to: [{ name: `Lead ${i % 10}`, email: `lead${i % 10}@cold.test` }], bodyText: `Dear Lead${i},\n\n${PITCH}\n\nSincerely,\nAna`, date: START - day * (i + 1) }));
    await t.learned();
    const lead = { name: "Lead 1", email: "lead1@cold.test" };
    const { thread } = await t.received({ from: lead, bodyText: "Hola Ana, gracias por el correo, me interesa mucho y quiero saber cómo funciona con mi equipo." });
    const r = await t.compose({ kind: "reply", threadId: thread, to: [lead] });
    expect(r.status === "done" && r.used).toMatchObject({ language: "es", languageReason: "inbound" });
  });

  it("an account that goes takes what it knew about templates with it", async () => {
    const t = await setup({ accounts: 2 });
    const gone = t.accounts[1]!;
    await t.sentMany(30, (i) => ({ accountId: gone.id, to: [{ name: `Lead ${i}`, email: `lead${i}@cold${i}.test` }], bodyText: `Dear Lead${i},\n\n${PITCH}\n\nSincerely,\nAna`, date: START - day * (i + 1) }));
    await t.sentMany(10, (i) => ({ bodyText: REPLY(i), date: START - day * (i + 1) }));
    await t.learned();
    expect((await t.backend.writing.learner.templatedIn(gone.id)).size).toBeGreaterThan(0);
    await t.client.call("accounts.remove", { id: gone.id });
    await t.learned();
    expect((await t.backend.writing.learner.templatedIn(gone.id)).size).toBe(0);
  });

  it("clearing what's learned takes what it knew about templates too", async () => {
    const t = await setup();
    await campaign(t);
    await t.learned();
    expect((await t.backend.writing.learner.templatedIn(t.account.id)).size).toBeGreaterThan(0);
    await t.client.call("writing.profiles.clear", {});
    expect((await t.backend.writing.learner.templatedIn(t.account.id)).size).toBe(0);
  });
});
