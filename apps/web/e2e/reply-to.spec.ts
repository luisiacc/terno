import { parseRaw } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import { chipsOf, expect, recipientEmails, selectThread, stabilize, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

test.use({ backendOptions: { smtpCapture: true } });

for (const mode of ["reply", "replyAll"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Reply-To ${mode} (${theme}): displayed destinations match the queued payload and SMTP envelope`, { tag: "@design" }, async ({ app: page, server }, testInfo) => {
      const [account] = await server.backend.store.accounts.list();
      const now = Date.now();
      const incoming: IncomingMessage = {
        accountId: account!.id, providerMsgId: "helpdesk-reply-to", providerThreadId: null, rfcMessageId: "helpdesk@help.test", inReplyTo: null, references: [],
        from: { name: "Helpdesk", email: "noreply@help.test" }, replyTo: [{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }],
        to: [{ name: "Me", email: account!.email }, { name: "List", email: "LIST@HELP.TEST" }, { name: "Other", email: "other@help.test" }],
        cc: [{ name: "Other", email: "OTHER@HELP.TEST" }, { name: "Session", email: "session@help.test" }], bcc: [{ name: "Private", email: "secret@help.test" }],
        subject: "Helpdesk session", date: now, snippet: "Please reply to this session.", bodyText: "Please reply to this session.", bodyHtml: null, bodyState: "full", listId: null,
        isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
      };
      const { touched } = await server.backend.store.sync.ingest([incoming], { applyFilters: false, now, classifier: null });
      await server.backend.server.invoke("settings.update", { theme }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await selectThread(page, touched[0]!, 'in:inbox subject:"Helpdesk session"');
      await page.getByTestId(mode === "reply" ? "action-reply" : "action-reply-all").click();
      // as chips (plan 29): the quoted comma name is one recipient
      await expect(chipsOf(page, "compose-to")).toHaveText(["Support, Session", "List"]);
      expect(await recipientEmails(page, "compose-to")).toEqual(["session@help.test", "list@help.test"]);
      if (mode === "replyAll") expect(await recipientEmails(page, "compose-cc")).toEqual(["other@help.test"]);
      await page.getByTestId("compose-body").fill("Thanks for helping.");
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await stabilize(page);
      await page.screenshot({ path: testInfo.outputPath(`reply-to-${mode}-${theme}.png`) });
      await page.getByTestId("compose-send").click();
      await expect.poll(() => server.smtp.length).toBe(1);
      const destinations = mode === "replyAll" ? ["session@help.test", "list@help.test", "other@help.test"] : ["session@help.test", "list@help.test"];
      expect(server.smtp[0]!.rcpt).toEqual(destinations);
      const mail = await parseRaw(server.smtp[0]!.raw);
      expect(mail.to).toEqual(incoming.replyTo);
      expect(mail.cc).toEqual(mode === "replyAll" ? [{ name: "Other", email: "other@help.test" }] : []);
      expect(mail.bcc).toEqual([]);
      const sent = (await server.backend.store.debug.snapshot()).ops.find((o) => o.kind === "send")!;
      const op = (await server.backend.store.ops.get(sent.id))!;
      expect(JSON.parse(op.payload_json)).toMatchObject({ to: incoming.replyTo, cc: mode === "replyAll" ? [{ name: "Other", email: "other@help.test" }] : [], bcc: [] });
    });
  }
}
