import { describe, expect, it } from "vitest";
import { BODY_PART_UNITS } from "../body-parts";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

/** The owner's Microsoft mail: the code sits well past the 200-character snippet, and the subject names none. */
const SUBJECT = "Action required: Verify your email address";
const BODY = [
  "Microsoft",
  "Hello, Ana Pérez",
  "We need to verify your email address.",
  "You are receiving this email because you are in process of signing up for the program.",
  "As part of our ongoing effort to keep your identity and privacy protected, we need to confirm that you provided this email address for contact and verification purposes.",
  "If you did not sign-up for our program using this email address, please disregard this email.",
  "Please verify your email address by entering this code: 391372",
  "Your code will expire after 10 minutes.",
].join("\n\n");
/** Past one body part: the store captures it in parts. */
const LARGE = `${BODY}\n\n${"Microsoft respects your privacy. ".repeat(Math.ceil(BODY_PART_UNITS / 32) + 10)}`;

/**
 * Plan 261: a message's verification code is found in its whole text when the text arrives (not in its snippet) and
 * stored with it; its thread carries the newest message's; mail of yours, and a reply's subject, give none.
 */
export function defineCodesConformance(fresh: () => Promise<MailStore>): void {
  describe("verification codes stored with the mail (plan 261)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const arrive = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, subject: SUBJECT, bodyText: BODY, ...over });
        const r = await store.sync.ingest([m], { applyFilters: true, now: 0, classifier: null });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const code = async (thread: number) => (await store.threads.summaries([thread]))[0]!.code;
      return { store, arrive, code };
    }

    it("finds a code past the snippet, on the message, its thread and what the AI reads", async () => {
      const { store, arrive, code } = await setup();
      const m = await arrive();
      expect(await code(m.thread)).toBe("391372");
      expect((await store.aiSummaries.sources(m.thread))!.messages[0]!.code).toBe("391372");
      // nothing like a code: none
      const plain = await arrive({ subject: "Lunch", bodyText: "See you at noon." });
      expect(await code(plain.thread)).toBeUndefined();
      expect((await store.aiSummaries.sources(plain.thread))!.messages[0]!.code).toBeNull();
    });

    it("a body captured in parts, at ingest or arriving later, gives its code", async () => {
      const { store, arrive, code } = await setup();
      expect(await code((await arrive({ bodyText: LARGE })).thread)).toBe("391372");
      const late = await arrive({ bodyText: null, bodyState: "none" });
      expect(await code(late.thread)).toBeUndefined();
      await store.sync.setBody(late.id, LARGE, null, { now: 0, classifier: null });
      expect(await code(late.thread)).toBe("391372");
    });

    it("a header-only message reads its snippet until the body comes, which then decides", async () => {
      const { store, arrive, code } = await setup();
      const m = await arrive({ subject: "Your sign-in code", snippet: "Enter 482913 to continue", bodyText: null, bodyState: "none" });
      expect(await code(m.thread)).toBe("482913");
      await store.sync.setBody(m.id, BODY, null, { now: 0, classifier: null });
      expect(await code(m.thread)).toBe("391372");
      await store.sync.setBody(m.id, "Welcome aboard.", null, { now: 0, classifier: null });
      expect(await code(m.thread)).toBeUndefined();
    });

    it("the thread carries its newest message's: a later message without one, or one of yours, clears it", async () => {
      const { store, arrive, code } = await setup();
      const first = await arrive({ rfcMessageId: "code@test", date: 1_000 });
      expect(await code(first.thread)).toBe("391372");
      // your reply quotes nothing and carries the code's words: yours never offers one
      const yours = await arrive({ isSent: true, inInbox: false, inReplyTo: "code@test", references: ["code@test"], subject: `Re: ${SUBJECT}`, bodyText: "My code is 555111", date: 2_000 });
      expect(await code(first.thread)).toBeUndefined();
      expect((await store.aiSummaries.sources(first.thread))!.messages.map((m) => m.code)).toEqual(["391372", null]);
      // Codex code review: the newer ones gone, the older code is the thread's again
      const later = await arrive({ inReplyTo: "code@test", references: ["code@test"], subject: `Re: ${SUBJECT}`, bodyText: "Lunch tomorrow?", date: 3_000 });
      expect(await code(first.thread)).toBeUndefined();
      await store.sync.remove([later.id]);
      expect(await code(first.thread)).toBeUndefined();
      await store.sync.remove([yours.id]);
      expect(await code(first.thread)).toBe("391372");
    });

    it("a message that answers another takes no code from its subject, even without Re:", async () => {
      const { arrive, code } = await setup();
      await arrive({ rfcMessageId: "orig@test", subject: "Your code 482913", bodyText: "Your code 482913", date: 1_000 });
      const reply = await arrive({ inReplyTo: "orig@test", references: ["orig@test"], subject: "Your code 482913", bodyText: "Thanks, it worked", date: 2_000 });
      expect(await code(reply.thread)).toBeUndefined();
      // Codex code review: References alone threads it too
      await arrive({ rfcMessageId: "orig2@test", subject: "Your code 551234", bodyText: "Your code 551234", date: 3_000 });
      const referencing = await arrive({ references: ["orig2@test"], subject: "Your code 551234", bodyText: "Thanks, it worked", date: 4_000 });
      expect(await code(referencing.thread)).toBeUndefined();
    });
  });
}
