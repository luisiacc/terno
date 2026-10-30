import { parseRaw } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { addRecipients, chipsOf, expect, recipientEmails, selectThread, stabilize, test } from "./fixtures";
import { E2E_NOW } from "./constants";

const ctx = { clientId: "setup", origin: "dev" as const };
const client = { name: "Client, One", email: "client@example.test" };
const teammate = { name: "Teammate", email: "team@example.test" };
const alias = { name: "Support", email: "support@example.test" };
const old = { name: "Old contact", email: "old@example.test" };
const forwarded = { name: "Forward recipient", email: "forward@example.test" };

test.use({ backendOptions: { smtpCapture: true } });

for (const mode of ["reply", "replyAll", "forward"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`own alias copy ${mode} (${theme}): chips, queue and SMTP keep recipients and source`, async ({ app: page, server }, testInfo) => {
      const [account] = await server.backend.store.accounts.list();
      const me = { name: "Me", email: account!.email };
      const first: IncomingMessage = {
        accountId: account!.id, providerMsgId: "own-first", providerThreadId: null, rfcMessageId: "own-first@example.test", inReplyTo: null, references: [],
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
      if (mode !== "replyAll") await page.getByTestId("compose-show-cc").click();
      const displayedCc = await recipientEmails(page, "compose-cc");
      expect(displayedTo).toEqual(to.map((a) => a.email));
      expect(displayedCc).toEqual(cc.map((a) => a.email));
      await page.getByTestId("compose-show-bcc").click();
      expect(await recipientEmails(page, "compose-bcc")).toEqual([]);
      await page.getByTestId("compose-body").fill("Follow-up text.");
      await page.getByTestId("compose-quote").click();
      const quoteId = await page.getByTestId("compose-quote").getAttribute("aria-controls");
      await expect(page.locator(`[id="${quoteId}"]`)).toContainText("latest-own-body");
      await expect(page.getByTestId("compose-send")).toBeEnabled();
      await page.getByTestId("compose-send").scrollIntoViewIfNeeded();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await stabilize(page);
      await page.screenshot({ path: testInfo.outputPath(`own-${mode}-${theme}.png`) });
      await page.getByTestId("compose-send").click();
      await expect.poll(() => server.smtp.length).toBe(1);
      expect(server.smtp[0]!.rcpt).toEqual([...displayedTo, ...displayedCc]);
      const mail = await parseRaw(server.smtp[0]!.raw);
      expect(mail.to).toEqual(to);
      expect(mail.cc).toEqual(cc);
      expect(mail.bcc).toEqual([]);
      expect(mail.text).toContain("latest-own-body");
      expect(mail.text).not.toContain("earlier-own-body");
      expect(mail.inReplyTo).toBe(mode === "forward" ? null : latest.rfcMessageId);
      expect(mail.references).toEqual(mode === "forward" ? [] : [first.rfcMessageId, latest.rfcMessageId]);
      const sent = (await server.backend.store.debug.snapshot()).ops.filter((o) => o.kind === "send");
      expect(sent).toHaveLength(1);
      const op = (await server.backend.store.ops.get(sent[0]!.id))!;
      const payload = JSON.parse(op.payload_json);
      expect(payload.to).toEqual(to);
      expect(payload.cc).toEqual(cc);
      expect(payload.bcc).toEqual([]);
      expect(payload.inReplyTo).toBe(mode === "forward" ? null : latest.rfcMessageId);
      expect(payload.references).toEqual(mode === "forward" ? [] : [first.rfcMessageId, latest.rfcMessageId]);
      expect(JSON.stringify(payload)).not.toContain("original-private@example.test");
    });
  }
}
