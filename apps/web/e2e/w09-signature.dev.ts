import AxeBuilder from "@axe-core/playwright";
import { parseRaw } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { addRecipients, expect, recipientEmails, selectThread, test } from "./fixtures";
import { E2E_NOW } from "./constants";
import { armSaveGate, rows, switches } from "./w09-signature-helper";

const ctx = { clientId: "w09", origin: "dev" as const };
test.use({ backendOptions: { smtpCapture: true } });
const blocked = new WeakMap<import("@playwright/test").BrowserContext, string[]>();
test.beforeEach(async ({ context }) => {
  const unexpected: string[] = []; blocked.set(context, unexpected);
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost", "::1"].includes(u.hostname)) return route.continue();
    unexpected.push(u.href); return route.abort();
  });
});
for (const mode of ["new", "reply", "replyAll", "forward"] as const) for (const theme of ["light", "dark"] as const) {
  test(`${mode} selected account, pending editor, durable reopen and SMTP (${theme})`, async ({ app: page, server, context }, info) => {
    const unexpected = blocked.get(context)!;
    const accounts = (await server.backend.store.accounts.list()).slice(0, 2).map((a, i) => ({ ...a, signature: i === 0 ? "Signature A  \n" : mode === "new" ? "  \n " : mode === "reply" ? "" : "Signature B  \n" }));
    for (const a of accounts) await server.backend.server.invoke("accounts.update", { id: a.id, signature: a.signature }, ctx);
    const language = theme === "dark" ? "es" : "en";
    await server.backend.server.invoke("settings.update", { theme, language }, ctx);
    await page.addInitScript((v) => localStorage.setItem("terno:language", v), language);
    const source: IncomingMessage = {
      accountId: accounts[0]!.id, providerMsgId: "w09-list", providerThreadId: null, rfcMessageId: "w09-list@example.test", inReplyTo: null, references: [],
      from: { name: "List author", email: "author@example.test" },
      replyTo: [{ name: "List, Help", email: "help@example.test" }, { name: "Duplicate", email: "HELP@EXAMPLE.TEST" }, { name: "", email: "" }],
      to: [{ name: "Me", email: accounts[0]!.email }, { name: "Member", email: " member@example.test " }],
      cc: [{ name: "Repeated", email: "MEMBER@EXAMPLE.TEST" }, { name: "Team", email: "team@example.test" }], bcc: [{ name: "Private", email: "private@example.test" }],
      subject: "W09 list", date: E2E_NOW, snippet: "Source list body", bodyText: "Source list body", bodyHtml: null, bodyState: "full", listId: "help.example.test",
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
    };
    const { touched } = await server.backend.store.sync.ingest([source], { applyFilters: false, now: E2E_NOW, classifier: null });
    await page.reload(); await page.locator("[data-ready]").waitFor();
    if (mode === "new") {
      await page.getByTestId("compose-button").click();
      await addRecipients(page, "compose-to", "Forward <forward@example.test>");
      await page.getByTestId("compose-subject").fill("W09 new");
    } else {
      await selectThread(page, touched[0]!, 'in:inbox subject:"W09 list"');
      await page.getByTestId(mode === "replyAll" ? "action-reply-all" : `action-${mode}`).click();
      if (mode === "forward") await addRecipients(page, "compose-to", "Forward <forward@example.test>");
    }
    const expectedTo = mode === "new" || mode === "forward" ? ["forward@example.test"] : ["help@example.test"];
    expect(await recipientEmails(page, "compose-to")).toEqual(expectedTo);
    const expectedCc = mode === "replyAll" ? ["member@example.test", "team@example.test"] : [];
    if (mode !== "replyAll") await page.getByTestId("compose-show-cc").click();
    expect(await recipientEmails(page, "compose-cc")).toEqual(expectedCc);
    const { saved, before } = await switches(page, accounts);
    const displayedTo = await page.getByTestId("compose-to-field").getByTestId("recipient-chip").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.email));
    const displayedCc = await page.getByTestId("compose-cc-field").getByTestId("recipient-chip").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.email));
    expect(displayedTo).toEqual(expectedTo); expect(displayedCc).toEqual(expectedCc);
    // SQL independently witnesses the normalized durable DTO, not a synthetic save result.
    const row = (await server.backend.store.drafts.list()).find((d) => d.id === saved.id)!;
    expect(row).toMatchObject({ account_id: accounts[1]!.id, thread_id: null, in_reply_to_message_id: before.inReplyToMessageId, forward_of_message_id: before.forwardOfMessageId, body_text: saved.bodyText, body_html: saved.bodyHtml });
    expect(saved.threadId).toBeNull();
    expect(saved.inReplyToMessageId).toBe(before.inReplyToMessageId); expect(saved.forwardOfMessageId).toBe(before.forwardOfMessageId);
    expect(saved.replyContext).toEqual(before.replyContext ?? null);
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${mode}-${theme}-${language}.png`) });
    await page.getByTestId("compose-send").click();
    await expect.poll(() => server.smtp.length).toBe(1);
    const wire = server.smtp[0]!;
    const assertEnvelope = (from: string, rcpt: string[]) => { expect(from).toBe(accounts[1]!.email); expect(rcpt).toEqual([...displayedTo, ...displayedCc]); };
    assertEnvelope(wire.from, wire.rcpt);
    expect(() => assertEnvelope(accounts[0]!.email, wire.rcpt)).toThrow();
    expect(() => assertEnvelope(wire.from, [...wire.rcpt, "private@example.test"])).toThrow();
    const mail = await parseRaw(wire.raw);
    expect(mail.from.email).toBe(accounts[1]!.email);
    expect(mail.to.map((a) => a.email)).toEqual(expectedTo); expect(mail.cc.map((a) => a.email)).toEqual(expectedCc); expect(mail.bcc).toEqual([]);
    const sig = accounts[1]!.signature.trim() ? "\n\n-- \nSignature B" : "";
    const text = `Authored Signature A bold pending${sig}${before.includeQuote && before.quotedText ? `\n\n${before.quotedText}` : ""}`;
    const assertText = (value: string | null) => expect(value?.replaceAll("\r\n", "\n").trimEnd()).toBe(text.trimEnd());
    assertText(mail.text); expect(() => assertText(text.replace("bold pending", "stale"))).toThrow();
    const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const lines = before.quotedText.split("\n");
    const quote = !before.includeQuote || !before.quotedText ? "" : mode === "forward"
      ? `<div><br></div>${lines.map((line) => `<div>${escape(line) || "<br>"}</div>`).join("")}`
      : `<div><br></div><div>${escape(lines[0]!)}</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><div>Source list body</div></blockquote>`;
    const expectedHtml = `<div>Authored Signature A <b>bold</b> pending</div>${sig ? "<div><br></div><div>-- <br>Signature B</div>" : ""}${quote}`;
    const actualHtml = await page.evaluate((html) => new DOMParser().parseFromString(html!, "text/html").body.innerHTML, mail.html);
    expect(actualHtml).toBe(expectedHtml);
    expect(mail.inReplyTo).toBe(mode === "reply" || mode === "replyAll" ? source.rfcMessageId : null);
    expect(mail.references).toEqual(mode === "reply" || mode === "replyAll" ? [source.rfcMessageId] : []);
    expect(mail.html?.match(/-- <br>Signature B/g) ?? []).toHaveLength(sig ? 1 : 0);
    const ops = (await server.backend.store.debug.snapshot()).ops.filter((o) => o.kind === "send"); expect(ops).toHaveLength(1);
    const op = (await server.backend.store.ops.get(ops[0]!.id))!;
    const payload = JSON.parse(op.payload_json);
    expect(op.account_id).toBe(accounts[1]!.id); expect(payload.from.email).toBe(accounts[1]!.email); expect(payload.text).toBe(text); expect(payload.html).toBe(mail.html);
    expect(payload.to.map((a: { email: string }) => a.email)).toEqual(expectedTo); expect(payload.cc.map((a: { email: string }) => a.email)).toEqual(expectedCc); expect(payload.bcc).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}


test("renderer Send waits for an actual durable save ACK", async ({ app: page, server, context }) => {
  await page.getByTestId("compose-button").click();
  await addRecipients(page, "compose-to", "recipient@example.test");
  await page.getByTestId("compose-subject").fill("W09 send gate");
  const body = page.getByTestId("compose-body"); await body.fill("Baseline");
  await expect.poll(async () => (await rows(page))[0]?.bodyText).toBe("Baseline");
  const baseline = (await rows(page))[0]!;
  await armSaveGate(page);
  await body.press("End"); await page.keyboard.type(" pending Send");
  await expect.poll(() => page.evaluate(() => (window as unknown as { w09Gate: { entered: boolean } }).w09Gate.entered)).toBe(true);
  await page.getByTestId("compose-send").click();
  const gate = await page.evaluate(() => (window as unknown as { w09Gate: { sends: number } }).w09Gate.sends);
  const assertBlocked = (sends: number, wire: number) => { expect(sends).toBe(0); expect(wire).toBe(0); };
  assertBlocked(gate, server.smtp.length);
  expect(() => assertBlocked(1, server.smtp.length)).toThrow();
  expect(await rows(page)).toEqual([baseline]);
  await page.evaluate(() => (window as unknown as { w09Gate: { release(): void } }).w09Gate.release());
  await expect.poll(() => server.smtp.length).toBe(1);
  const mail = await parseRaw(server.smtp[0]!.raw);
  expect(mail.text).toContain("Baseline pending Send");
  expect(server.smtp[0]!.rcpt).toEqual(["recipient@example.test"]);
  expect(blocked.get(context)).toEqual([]);
});
