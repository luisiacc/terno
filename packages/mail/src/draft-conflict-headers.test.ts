import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../db/src/index";
import { SqlMailStore } from "../../db/src/sql-store";
import { ingest, msg, withAccounts } from "../../store/src/conformance/fixtures";
import { buildRaw } from "./compose";
import { buildRawPortable } from "./compose-portable";
import { parseRaw } from "./mime";
import type { SendPayload } from "./types";

it.each(["Re: Original", "Changed conversation"])("stale-save omission reaches desktop and portable MIME with correct linkage: %s", async (subject) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-conflict-headers-"));
  const path = join(dir, "mail.db");
  let store = new SqlMailStore(openDatabase(path));
  try {
    const [accountId] = await withAccounts(store);
    await ingest(store, [msg({ accountId: accountId!, providerMsgId: "source", subject: "Original", rfcMessageId: "source@example.test", references: ["ancestor@example.test"], providerThreadId: "native-source" })]);
    const source = (await store.debug.snapshot()).messages[0]!;
    const fields = { accountId: accountId!, mode: "reply" as const, inReplyToMessageId: source.id, to: [{ name: "Recipient", email: "recipient@example.test" }], cc: [], subject: "Re: Original", bodyText: "first" };
    const draft = (await store.drafts.save({ ...fields, replyContext: { subject: "Original", sourceId: source.id, sourceAccountId: accountId! } }, 0))!;
    await store.drafts.save({ ...fields, id: draft.id, generation: draft.generation, baseRevision: draft.revision, bodyText: "latest" }, 1);
    const copy = (await store.drafts.save({ ...fields, id: draft.id, generation: draft.generation, baseRevision: draft.revision, subject, bodyText: "authored conflict copy" }, 2))!;
    await store.close();
    store = new SqlMailStore(openDatabase(path));
    const reopened = (await store.drafts.list()).find((d) => d.id === copy.id)!;
    const sent = await store.compose.queueSend({ accountId: accountId!, to: fields.to, cc: [], bcc: [], subject: reopened.subject, bodyText: reopened.body_text, inReplyToMessageId: source.id, draftId: copy.id, draftGeneration: copy.generation, draftRevision: copy.revision, recordReply: false, now: 3 });
    const payload = JSON.parse((await store.ops.get(sent.opId))!.payload_json) as SendPayload;
    const linked = subject === "Re: Original";
    expect(payload.providerThreadId).toBe(linked ? "native-source" : null);
    for (const raw of [await buildRaw(payload), await buildRawPortable(payload)]) {
      const parsed = await parseRaw(raw);
      expect(parsed).toMatchObject({ subject, to: fields.to, inReplyTo: linked ? "source@example.test" : null, references: linked ? ["ancestor@example.test", "source@example.test"] : [] });
      expect(parsed.text?.trim()).toBe("authored conflict copy");
      const headers = new TextDecoder().decode(raw).split("\r\n\r\n")[0]!;
      expect(/^In-Reply-To:/mi.test(headers)).toBe(linked);
      expect(/^References:/mi.test(headers)).toBe(linked);
    }
    expect((await store.drafts.list())[0]).toMatchObject({ id: draft.id, body_text: "latest" });
  } finally {
    if (store.isOpen) await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
