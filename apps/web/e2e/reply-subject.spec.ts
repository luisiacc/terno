import { parseRaw } from "@terno/mail";
import AxeBuilder from "@axe-core/playwright";
import { createGmailApiProvider } from "../../../packages/mail/src/gmail-api";
import { buildRaw } from "../../../packages/mail/src/compose";
import type { SendPayload } from "../../../packages/mail/src/types";
import type { IncomingMessage } from "@terno/store";
import { addRecipients, chipsOf, expect, recipientEmails, selectThread, stabilize, test } from "./browser-forward-fixtures";
import { E2E_NOW } from "./constants";

const ctx = { clientId: "setup", origin: "dev" as const };
const client = { name: "Client, One", email: "client@example.test" };
const teammate = { name: "Teammate", email: "team@example.test" };
const alias = { name: "Support", email: "support@example.test" };
const old = { name: "Old contact", email: "old@example.test" };
const forwarded = { name: "Forward recipient", email: "forward@example.test" };

test.use({ backendOptions: { smtpCapture: true } });

for (const mode of ["reply", "replyAll", "forward"] as const) {
  for (const scenario of ["changed", "normalized", "restored"] as const) {
    const theme = "light";
    test(`${scenario} subject ${mode} (${theme}): chips, queue and SMTP keep recipients and source`, async ({ app: page, server }, testInfo) => {
      const [account] = await server.backend.store.accounts.list();
      const me = { name: "Me", email: account!.email };
      const first: IncomingMessage = {
        accountId: account!.id, providerMsgId: "own-first", providerThreadId: "synthetic-provider-thread", rfcMessageId: "own-first@example.test", inReplyTo: null, references: [],
        from: alias, replyTo: [old], to: [old], cc: [], bcc: [{ name: "Original private", email: "original-private@example.test" }],
        subject: "W09 own follow-up", date: E2E_NOW - 1000, snippet: "earlier-own-body", bodyText: "earlier-own-body", bodyHtml: null, bodyState: "full", listId: null,
        isRead: true, isStarred: false, inInbox: true, isSent: true, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
      };
      const latest: IncomingMessage = {
        ...first, providerMsgId: "own-latest", rfcMessageId: "own-latest@example.test", inReplyTo: first.rfcMessageId, references: [first.rfcMessageId!],
        isSent: false, date: E2E_NOW, to: [me, client, { ...client, email: "CLIENT@EXAMPLE.TEST" }], cc: [client, teammate, alias],
        snippet: "latest-own-body", bodyText: "latest-own-body",
      };
      const { touched } = await server.backend.store.sync.ingest([first, latest], { applyFilters: false, now: E2E_NOW, classifier: null });
      const detail = (await server.backend.store.threads.get(touched[0]!))!;
      expect(detail.messages.map((m) => m.rfcMessageId)).toEqual([first.rfcMessageId, latest.rfcMessageId]);
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      const submissions: { forwardOfMessageId?: number; inReplyToMessageId?: number }[] = [];
      page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.t === "req" && frame.m === "compose.send") submissions.push(frame.p);
      }));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await selectThread(page, touched[0]!, 'in:inbox subject:"W09 own follow-up"');
      await page.getByTestId(mode === "replyAll" ? "action-reply-all" : `action-${mode}`).click();
      if (mode === "forward") {
        await expect(chipsOf(page, "compose-to")).toHaveCount(0);
        await addRecipients(page, "compose-to", "Forward recipient <forward@example.test>");
      }
      const to = mode === "forward" ? [forwarded] : [client];
      const cc = mode === "replyAll" ? [teammate] : [];
      await expect(chipsOf(page, "compose-to")).toHaveText(to.map((a) => a.name));
      const displayedTo = await recipientEmails(page, "compose-to");
      if (mode !== "replyAll") { await page.getByTestId("compose-show-cc").click(); await expect(page.getByTestId("compose-cc")).toBeFocused(); }
      const displayedCc = await recipientEmails(page, "compose-cc");
      expect(displayedTo).toEqual(to.map((a) => a.email));
      expect(displayedCc).toEqual(cc.map((a) => a.email));
      await page.getByTestId("compose-show-bcc").click();
      await expect(page.getByTestId("compose-bcc")).toBeFocused();
      expect(await recipientEmails(page, "compose-bcc")).toEqual([]);
      if (mode !== "forward") await page.getByTestId("compose-show-subject").click();
      await page.getByTestId("compose-subject").fill("New synthetic topic");
      if (scenario !== "changed") await page.getByTestId("compose-subject").fill(scenario === "normalized" ? "re: Re: W09 own follow-up" : "Re: W09 own follow-up");
      await page.getByTestId("compose-body").fill("Follow-up text.");
      await page.getByTestId("compose-quote").click();
      const quoteId = await page.getByTestId("compose-quote").getAttribute("aria-controls");
      await expect(page.locator(`[id="${quoteId}"]`)).toContainText("latest-own-body");
      await expect(page.getByTestId("compose-send")).toBeEnabled();
      await page.getByTestId("compose-send").scrollIntoViewIfNeeded();
      await expect(page.locator("html")).toHaveClass(/^(?!.*\bdark\b)/);
      await stabilize(page);
      await page.screenshot({ path: testInfo.outputPath(`own-${mode}-${theme}.png`) });
      await page.getByTestId("compose-send").click();
      await expect.poll(() => server.smtp.length).toBe(1);
      expect(server.smtp[0]!.rcpt).toEqual([...displayedTo, ...displayedCc]);
      const mail = await parseRaw(server.smtp[0]!.raw);
      expect(server.smtp[0]!.from).toBe(account!.email);
      expect(mail.subject).toBe(scenario === "changed" ? "New synthetic topic" : scenario === "normalized" ? "re: Re: W09 own follow-up" : "Re: W09 own follow-up");
      expect(mail.text).toContain("Follow-up text.");
      expect(mail.to).toEqual(to);
      expect(mail.cc).toEqual(cc);
      expect(mail.bcc).toEqual([]);
      expect(mail.text).toContain("latest-own-body");
      expect(mail.text).not.toContain("earlier-own-body");
      expect(mail.inReplyTo).toBe(mode === "forward" || scenario === "changed" ? null : latest.rfcMessageId);
      expect(mail.references).toEqual(mode === "forward" || scenario === "changed" ? [] : [first.rfcMessageId, latest.rfcMessageId]);
      const sent = (await server.backend.store.debug.snapshot()).ops.filter((o) => o.kind === "send");
      expect(sent).toHaveLength(1);
      const op = (await server.backend.store.ops.get(sent[0]!.id))!;
      const payload = JSON.parse(op.payload_json);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.forwardOfMessageId).toBe(mode === "forward" ? detail.messages[1]!.id : undefined);
      expect(submissions[0]!.inReplyToMessageId).toBe(mode === "forward" ? undefined : detail.messages[1]!.id);
      expect(payload.to).toEqual(to);
      expect(payload.cc).toEqual(cc);
      expect(payload.bcc).toEqual([]);
      expect(payload.inReplyTo).toBe(mode === "forward" || scenario === "changed" ? null : latest.rfcMessageId);
      expect(payload.references).toEqual(mode === "forward" || scenario === "changed" ? [] : [first.rfcMessageId, latest.rfcMessageId]);
      expect(payload.providerThreadId).toBe(mode === "forward" || scenario === "changed" ? null : "synthetic-provider-thread");
      const requests: Record<string, string>[] = [];
      const provider = createGmailApiProvider({ account: { id: account!.id }, store: {}, fetch: async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(typeof init.body === "string" ? init.body : await (init.body as Blob).text()));
        return Response.json({ id: "synthetic-sent", threadId: "synthetic-result" });
      } } as never, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw });
      await provider.execute({ id: "synthetic-send", kind: "send", target: {}, payload: payload as SendPayload });
      expect(requests).toHaveLength(1);
      const linked = mode !== "forward" && scenario !== "changed";
      expect(requests[0]!.threadId).toBe(linked ? "synthetic-provider-thread" : undefined);
      const gmail = await parseRaw(Buffer.from(requests[0]!.raw!, "base64url"));
      expect(gmail.inReplyTo).toBe(linked ? latest.rfcMessageId : null);
      expect(gmail.references).toEqual(linked ? [first.rfcMessageId, latest.rfcMessageId] : []);
      expect(gmail.subject).toBe(payload.subject);
      expect(JSON.stringify(payload)).not.toContain("original-private@example.test");
    });
  }
}

test("saved reply uses its original baseline after the thread subject changes and reloads", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  const original: IncomingMessage = {
    accountId: account!.id, providerMsgId: "baseline-original", providerThreadId: "baseline-native", rfcMessageId: "baseline-original@example.test", inReplyTo: null, references: [],
    from: client, to: [{ name: "Me", email: account!.email }], cc: [], bcc: [], subject: "Baseline topic", date: E2E_NOW - 1000, snippet: "original body", bodyText: "original body", bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  };
  await server.backend.store.sync.ingest([{ ...original, providerMsgId: "baseline-other", providerThreadId: null, rfcMessageId: "baseline-other@example.test", subject: "Changed current topic" }], { applyFilters: false, now: E2E_NOW, classifier: null });
  const ingested = await server.backend.store.sync.ingest([original], { applyFilters: false, now: E2E_NOW, classifier: null });
  const threadId = ingested.touched[0]!;
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await selectThread(page, threadId, 'in:inbox subject:"Baseline topic"');
  await page.getByTestId("action-reply").click();
  await page.getByTestId("compose-show-subject").click();
  await page.getByTestId("compose-subject").fill("Re: Baseline topic");
  await page.getByTestId("compose-body").fill("Preserved author text");
  await expect.poll(async () => (await server.backend.store.drafts.list()).some((d) => d.subject === "Re: Baseline topic" && d.body_text === "Preserved author text" && Boolean(d.reply_context_json))).toBe(true);
  await server.backend.store.sync.ingest([{ ...original, providerMsgId: "baseline-newer", providerThreadId: null, rfcMessageId: "baseline-newer@example.test", inReplyTo: original.rfcMessageId, references: [original.rfcMessageId!, "baseline-other@example.test"], subject: "Changed current topic", date: E2E_NOW, bodyText: "newer body", snippet: "newer body" }], { applyFilters: false, now: E2E_NOW, classifier: null });
  const mergedId = (await server.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "baseline-original")!.threadId;
  const detail = (await server.backend.store.threads.get(mergedId))!;
  expect(detail.thread.subject).toBe("Changed current topic");
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await selectThread(page, mergedId, 'in:inbox subject:"Changed current topic"');
  await page.getByTestId("action-reply").click();
  await page.getByTestId("compose-show-subject").click();
  await expect(page.getByTestId("compose-subject")).toHaveValue("Re: Baseline topic");
  await expect(page.getByTestId("compose-body")).toContainText("Preserved author text");
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  const sent = await parseRaw(server.smtp[0]!.raw);
  expect(sent.inReplyTo).toBe(original.rfcMessageId);
  expect(sent.text).toContain("original body");
  expect(sent.text).not.toContain("newer body");
});

for (const theme of ["light", "dark"] as const) {
  test(`a removed reply source retains the draft and explains refusal (${theme})`, async ({ app: page, server }) => {
    const [account] = await server.backend.store.accounts.list();
    const original: IncomingMessage = {
      accountId: account!.id, providerMsgId: "lost-source", providerThreadId: "lost-native", rfcMessageId: "lost@example.test", inReplyTo: null, references: [], from: client,
      to: [{ name: "Me", email: account!.email }], cc: [], bcc: [], subject: "Lost source", date: E2E_NOW, snippet: "source quote", bodyText: "source quote", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
    };
    const result = await server.backend.store.sync.ingest([original], { applyFilters: false, now: E2E_NOW, classifier: null });
    const id = (await server.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "lost-source")!.id;
    const language = theme === "dark" ? "es" : "en";
    await server.backend.server.invoke("settings.update", { theme, language }, ctx);
    await page.addInitScript((locale) => localStorage.setItem("terno:language", locale), language);
    await page.reload(); await page.locator("[data-ready]").waitFor();
    await selectThread(page, result.touched[0]!, 'in:inbox subject:"Lost source"');
    await page.getByTestId("action-reply").click();
    await page.getByTestId("compose-show-subject").click();
    await page.getByTestId("compose-subject").fill("New topic");
    await page.getByTestId("compose-body").fill("Keep my work");
    await expect.poll(async () => (await server.backend.store.drafts.list()).some((d) => d.subject === "New topic" && d.body_text === "Keep my work" && Boolean(d.reply_context_json))).toBe(true);
    await server.backend.store.sync.remove([id]);
    await page.getByTestId("compose-send").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText(language === "es" ? "El mensaje original ya no está disponible" : "The original message is no longer available");
    await page.screenshot({ path: `/tmp/terno-w09-s37/source-removed-${theme}.png` });
    await expect(page.getByTestId("compose-body")).toContainText("Keep my work");
    expect(server.smtp).toHaveLength(0);
    expect((await server.backend.store.drafts.list())[0]).toMatchObject({ subject: "New topic", body_text: "Keep my work", mode: "reply", in_reply_to_message_id: id });
    expect((await new AxeBuilder({ page }).include("[data-testid=draft-slot]").analyze()).violations).toEqual([]);
    if (theme === "light") {
      await page.reload(); await page.locator("[data-ready]").waitFor();
      await page.getByTestId("strip-item").filter({ hasText: "New topic" }).click();
      await expect(page.getByTestId("compose-body")).toContainText("Keep my work");
      await page.getByTestId("compose-send").click();
      await expect(page.getByRole("alert")).toContainText("The original message is no longer available");
      expect(server.smtp).toHaveLength(0);
    }
  });
}

test("edited automatic recipient survives Undo, Forward conversion, reload and send", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  const source: IncomingMessage = {
    accountId: account!.id, providerMsgId: "f2-source", providerThreadId: "f2-native", rfcMessageId: "f2@example.test", inReplyTo: null, references: [], from: client,
    to: [{ name: "Me", email: account!.email }], cc: [], bcc: [], subject: "F2 subject", date: E2E_NOW, snippet: "source text", bodyText: "source text", bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  };
  const result = await server.backend.store.sync.ingest([source], { applyFilters: false, now: E2E_NOW, classifier: null });
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await selectThread(page, result.touched[0]!, 'in:inbox subject:"F2 subject"');
  await page.getByTestId("action-reply").click();
  const toInput = page.getByTestId("compose-to");
  await toInput.focus(); await toInput.press("Home"); await toInput.press("Backspace");
  await page.keyboard.press("F2"); await toInput.press("Enter");
  await toInput.press("Meta+z"); await toInput.press("Meta+z");
  await expect(chipsOf(page, "compose-to")).toHaveCount(1);
  await page.getByTestId("compose-body").fill("Authored F2 body");
  await page.getByTestId("action-forward").click();
  await expect(chipsOf(page, "compose-to")).toHaveCount(1);
  await expect.poll(async () => (await server.backend.store.drafts.list()).some((d) => d.mode === "forward" && d.body_text === "Authored F2 body")).toBe(true);
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await selectThread(page, result.touched[0]!, 'in:inbox subject:"F2 subject"');
  await page.getByTestId("action-forward").click();
  expect(await recipientEmails(page, "compose-to")).toEqual([client.email]);
  await expect(page.getByTestId("compose-body")).toContainText("Authored F2 body");
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  expect(server.smtp[0]!.rcpt).toEqual([client.email]);
  const mail = await parseRaw(server.smtp[0]!.raw);
  expect(mail.inReplyTo).toBeNull(); expect(mail.references).toEqual([]);
  expect(mail.text).toContain("Authored F2 body");
});

test("untouched Reply to Reply all keeps its original source when new mail arrives", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  const source: IncomingMessage = {
    accountId: account!.id, providerMsgId: "untouched-original", providerThreadId: "untouched-native", rfcMessageId: "untouched-original@example.test", inReplyTo: null, references: [], from: client,
    to: [{ name: "Me", email: account!.email }], cc: [teammate], bcc: [], subject: "Untouched reply", date: E2E_NOW - 1000, snippet: "first source", bodyText: "first source", bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  };
  const first = await server.backend.store.sync.ingest([source], { applyFilters: false, now: E2E_NOW, classifier: null });
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await selectThread(page, first.touched[0]!, 'in:inbox subject:"Untouched reply"');
  await page.getByTestId("action-reply").click();
  await expect(chipsOf(page, "compose-to")).toHaveText([client.name]);
  const next = await server.backend.store.sync.ingest([{ ...source, providerMsgId: "untouched-newer", rfcMessageId: "untouched-newer@example.test", inReplyTo: source.rfcMessageId, references: [source.rfcMessageId!], from: old, bodyText: "new source", snippet: "new source", date: E2E_NOW }], { applyFilters: false, now: E2E_NOW, classifier: null });
  server.backend.notifyChanged(next.touched);
  await expect(page.getByTestId("reader").getByText("new source", { exact: true })).toBeVisible();
  await expect(page.getByTestId("row-snippet")).toHaveText("new source");
  await page.getByTestId("action-reply-all").click();
  await expect(chipsOf(page, "compose-to")).toHaveText([client.name]);
  expect(await recipientEmails(page, "compose-cc")).toEqual([teammate.email]);
  await page.getByTestId("compose-body").fill("Keep original source");
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  const mail = await parseRaw(server.smtp[0]!.raw);
  expect(mail.inReplyTo).toBe(source.rfcMessageId);
  expect(mail.text).toContain("first source");
  expect(mail.text).not.toContain("new source");
});
