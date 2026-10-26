import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_ACCOUNT_BYTES, ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, bytesBase64, type AttachmentRef } from "@terno/core";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

export function defineAttachmentConformance(name: string, h: StoreHarness): void {
  let store: MailStore;
  afterEach(async () => store?.isOpen && store.close());
  const fresh = async () => { store = await h.open(); return withAccounts(store); };
  const upload = async (accountId: number, data = "AP+A") => {
    const ref = await store.attachments.create({ accountId, filename: "../binary.dat", mime: "application/octet-stream", size: data.length ? 3 : 0, now: 0 });
    if (data) await store.attachments.append(accountId, ref.assetId, 0, data);
    await store.attachments.seal(accountId, ref.assetId);
    return ref;
  };
  const draft = (accountId: number, attachments: AttachmentRef[]) => ({ accountId, to: [], cc: [], subject: "files", bodyText: "keep me", attachments });
  const send = (accountId: number, attachments: AttachmentRef[]) => ({ accountId, to: [{ name: "", email: "receiver@test.com" }], cc: [], bcc: [], subject: "files", bodyText: "exact", attachments, recordReply: false, now: 0 });
  const fillQuota = async (accountId: number, used: number, now = 0) => {
    for (let left = ATTACHMENT_ACCOUNT_BYTES - used; left >= 1024;) {
      const size = Math.min(MAX_ATTACHMENT_BYTES, left - 1024);
      await store.attachments.create({ accountId, filename: "reservation", mime: "text/plain", size, now });
      left -= size + 1024;
    }
  };
  describe(`attachment conformance: ${name}`, () => {
    it("gives an old discarded draft a persisted full Undo grace, reset after each last unlink", async () => {
      const [a] = await fresh();
      const ref = await upload(a!);
      const input = draft(a!, [ref]);
      const saved = (await store.drafts.save(input, 0))!;
      await store.drafts.delete(saved.id);
      const cleanup = (now: number) => store.attachments.create({ accountId: a!, filename: "unrelated", mime: "text/plain", size: 0, now });
      await cleanup(172800000);
      store = await h.reopen(store);
      await cleanup(259200000);
      const restored = (await store.drafts.save(input, 259200000))!;
      store = await h.reopen(store);
      expect(JSON.parse((await store.drafts.list())[0]!.attachments_json)).toEqual([ref]);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      await store.drafts.delete(restored.id);
      await cleanup(432000000);
      store = await h.reopen(store);
      await cleanup(518400000);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      await cleanup(518400001);
      await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
    });
    it("persists orphan grace even when a full-quota reservation fails, then reclaims after reopen", async () => {
      const [a] = await fresh(); const ref = await upload(a!);
      const saved = (await store.drafts.save(draft(a!, [ref]), 0))!;
      await fillQuota(a!, ref.size + 1024, 172800000);
      await store.drafts.delete(saved.id);
      const create = (now: number) => store.attachments.create({ accountId: a!, filename: "new", mime: "text/plain", size: 0, now });
      await expect(create(172800000)).rejects.toThrow();
      store = await h.reopen(store);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      await expect(create(259200000)).rejects.toThrow();
      store = await h.reopen(store);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      await expect(create(259200001)).resolves.toMatchObject({ size: 0 });
      await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
    });
    it.each(["before", "after"] as const)("adopts a Sent copy at quota with exact bytes when markSent is %s ingestion", async (ordering) => {
      const [a] = await fresh();
      const ref = await upload(a!);
      const queued = await store.compose.queueSend(send(a!, [ref]));
      const local = (await store.threads.get(queued.threadId))!.messages[0]!;
      await store.ops.claimReady(0, 1);
      await store.ops.markUnknown(queued.opId, "acceptance unknown", 1);
      await fillQuota(a!, ref.size + 1024);
      if (ordering === "before") await store.ops.resolveUnknown(queued.opId, "markSent", 2);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "server-sent-id", rfcMessageId: ` <${local.rfcMessageId!.toUpperCase()}> `, inInbox: false, isSent: true, attachments: [{ filename: ref.filename, mime: ref.mime, size: ref.size, bytes: new Uint8Array([0, 255, 128]) }] })], 3);
      if (ordering === "after") await store.ops.resolveUnknown(queued.opId, "markSent", 4);
      store = await h.reopen(store);
      await store.attachments.create({ accountId: a!, filename: "cleanup", mime: "text/plain", size: 0, now: 172800000 });
      await store.attachments.create({ accountId: a!, filename: "after grace", mime: "text/plain", size: 0, now: 259200001 });
      store = await h.reopen(store);
      const adopted = (await store.threads.get(queued.threadId))!.messages;
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({ id: local.id, attachments: [expect.objectContaining(ref)] });
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      await expect(store.attachments.discard(a!, ref.assetId)).rejects.toThrow();
      await store.sync.remove([local.id]);
      await store.attachments.discard(a!, ref.assetId);
    });
    it("stages against the provider match before a local RFC collision, never a foreign account or nonlocal RFC match", async () => {
      const [a, b] = await fresh();
      const ref = await upload(a!);
      const queued = await store.compose.queueSend(send(a!, [ref]));
      const local = (await store.threads.get(queued.threadId))!.messages[0]!;
      const same = { filename: ref.filename, mime: ref.mime, size: ref.size, bytes: new Uint8Array([0, 255, 128]) };
      await ingest(store, [msg({ accountId: a!, providerMsgId: "provider-match", attachments: [{ ...same, bytes: new Uint8Array([1, 2, 3]) }] })]);
      const providerThread = await threadOf(store, "provider-match");
      const provider = (await store.threads.get(providerThread))!.messages[0]!;
      await fillQuota(a!, 2 * (ref.size + 1024));
      await ingest(store, [msg({ accountId: a!, providerMsgId: "provider-match", rfcMessageId: local.rfcMessageId, attachments: [same] })]);
      expect((await store.threads.get(providerThread))!.messages.find((m) => m.id === provider.id)!.attachments[0]!.assetId).toBeUndefined();
      expect((await store.threads.get(queued.threadId))!.messages.find((m) => m.id === local.id)!.attachments[0]!.assetId).toBe(ref.assetId);
      await fillQuota(b!, 0);
      await ingest(store, [msg({ accountId: b!, providerMsgId: "foreign", rfcMessageId: local.rfcMessageId, attachments: [same] }), msg({ accountId: a!, providerMsgId: "nonlocal-rfc", rfcMessageId: provider.rfcMessageId, attachments: [same] })]);
      for (const id of ["foreign", "nonlocal-rfc"]) {
        const thread = await threadOf(store, id);
        const message = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === id)!;
        expect((await store.threads.get(thread))!.messages.find((m) => m.id === message.id)!.attachments[0]!.assetId).toBeUndefined();
      }
    });
    it("retains exact binary and legitimate empty assets across restart; never crosses accounts", async () => {
      const [a, b] = await fresh();
      const ref = await upload(a!);
      const empty = await upload(a!, "");
      expect(ref.filename).toBe("binary.dat");
      store = await h.reopen(store);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
      expect(await store.attachments.info(a!, empty.assetId)).toMatchObject({ size: 0 });
      await expect(store.attachments.read(b!, ref.assetId, 0)).rejects.toThrow();
      await expect(store.attachments.info(a!, "missing")).rejects.toThrow();
    });
    it("refuses incomplete or foreign assets atomically, retaining the original draft", async () => {
      const [a, b] = await fresh();
      const ref = await upload(a!);
      const incomplete = await store.attachments.create({ accountId: a!, filename: "empty", mime: "text/plain", size: 0, now: 0 });
      const d = await store.drafts.save(draft(a!, [ref]), 0);
      for (const bad of [[incomplete], [ref, { ...ref, assetId: "missing-asset" }]]) {
        await expect(store.compose.queueSend({ ...send(a!, bad), draftId: d!.id })).rejects.toThrow();
      }
      await expect(store.drafts.save(draft(b!, [ref]), 0)).rejects.toThrow();
      await expect(store.compose.queueSend({ ...send(b!, []), draftId: d!.id })).rejects.toThrow();
      expect(await store.drafts.list()).toHaveLength(1);
      expect(await store.ops.recent(20)).toHaveLength(0);
    });
    it("captures immutable refs, rejects stale send revision, and cannot resurrect sent drafts", async () => {
      const [a] = await fresh();
      const ref = await upload(a!);
      const d = (await store.drafts.save(draft(a!, [ref]), 0))!;
      const edited = (await store.drafts.save({ ...draft(a!, []), id: d.id, baseRevision: d.revision }, 1))!;
      await expect(store.compose.queueSend({ ...send(a!, [ref]), draftId: d.id, draftRevision: d.revision })).rejects.toThrow();
      const q = await store.compose.queueSend({ ...send(a!, [ref]), draftId: edited.id, draftRevision: edited.revision });
      store = await h.reopen(store);
      expect(JSON.parse((await store.ops.get(q.opId))!.payload_json).attachments).toEqual([ref]);
      expect(await store.drafts.save({ ...draft(a!, []), id: d.id }, 2)).toBeNull();
      const m = (await store.threads.get(q.threadId))!.messages[0]!;
      expect(m.attachments[0]).toMatchObject(ref);
      expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
    });
    it.each(["complete", "markSent"] as const)("releases only the definitive successful operation pin (%s), through restart and cleanup", async (resolution) => {
      const [a] = await fresh();
      const ref = await upload(a!);
      const queued = await store.compose.queueSend(send(a!, [ref]));
      await store.ops.claimReady(0, 10);
      const message = (await store.threads.get(queued.threadId))!.messages[0]!;
      await store.sync.remove([message.id]);
      await expect(store.attachments.discard(a!, ref.assetId)).rejects.toThrow();
      await store.ops.markUnknown(queued.opId, "acceptance unknown", 1);
      await expect(store.attachments.discard(a!, ref.assetId)).rejects.toThrow();
      const independent = (await store.drafts.save(draft(a!, [ref]), 1))!;
      if (resolution === "markSent") await store.ops.resolveUnknown(queued.opId, "markSent", 2);
      else await store.ops.complete(queued.opId, {}, 2);
      store = await h.reopen(store);
      await expect(store.attachments.discard(a!, ref.assetId)).rejects.toThrow();
      await store.drafts.delete(independent.id);
      // The first observation starts grace; a later creation reclaims, with no timer.
      await store.attachments.create({ accountId: a!, filename: "cleanup", mime: "text/plain", size: 0, now: 172800000 });
      await store.attachments.create({ accountId: a!, filename: "after grace", mime: "text/plain", size: 0, now: 259200001 });
      store = await h.reopen(store);
      await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
      expect((await store.ops.get(queued.opId))!.state).toBe("succeeded");
    });
    it("retains the independent message pin after operation success, then reclaims on deletion", async () => {
      const [a] = await fresh(); const ref = await upload(a!);
      const queued = await store.compose.queueSend(send(a!, [ref]));
      await store.ops.claimReady(0, 10); await store.ops.complete(queued.opId, {}, 1);
      store = await h.reopen(store);
      await expect(store.attachments.discard(a!, ref.assetId)).rejects.toThrow();
      const message = (await store.threads.get(queued.threadId))!.messages[0]!;
      await store.sync.remove([message.id]);
      await store.attachments.discard(a!, ref.assetId);
      await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
    });
    it("persists parsed incoming bytes/CID at ingestion and body completion without duplicate parts", async () => {
      const [a] = await fresh();
      const incoming = msg({ accountId: a!, providerMsgId: "binary", hasAttachments: true, attachments: [{ filename: "same.png", mime: "image/png", size: 3, contentId: "photo", bytes: new Uint8Array([0, 255, 128]) }] });
      await ingest(store, [incoming]);
      const id = await threadOf(store, "binary");
      const original = (await store.threads.get(id))!.messages[0]!;
      expect(original.attachments).toHaveLength(1);
      expect(await store.attachments.read(a!, original.attachments[0]!.assetId!, 0)).toBe("AP+A");
      await ingest(store, [incoming]);
      expect((await store.threads.get(id))!.messages[0]!.attachments).toHaveLength(1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "partial", bodyState: "none", bodyText: null })]);
      const thread = await threadOf(store, "partial");
      const mid = (await store.threads.get(thread))!.messages[0]!.id;
      await store.sync.setBody(mid, "body", '<img src="cid:photo">', { now: 1, classifier: null, attachments: incoming.attachments });
      store = await h.reopen(store);
      expect((await store.threads.get(thread))!.messages[0]!.attachments[0]).toMatchObject({ contentId: "photo", size: 3 });
    });
    it("tracks legacy and inline-only capture independently of history/body state, once", async () => {
      const [a, b] = await fresh();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "legacy-inline", hasAttachments: false, locations: [{ mailbox: "INBOX", uid: 1, uidvalidity: 1, flags: [] }] }), msg({ accountId: b!, providerMsgId: "other" })]);
      const pending = await store.providerStore(a!).pendingAttachmentBodies(50);
      expect(pending.map((p) => p.providerMsgId)).toEqual(["legacy-inline"]);
      expect(await store.providerStore(a!).pendingBodies(50)).toHaveLength(1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "legacy-inline", attachments: [] })]);
      store = await h.reopen(store);
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toEqual([]);
      expect(await store.providerStore(b!).pendingAttachmentBodies(50)).toHaveLength(1);
    });
    it("accepts a large ASCII body whose actual encoded MIME fits the budget", async () => {
      const [a] = await fresh();
      await expect(store.compose.queueSend({ ...send(a!, []), bodyText: "a".repeat(7 * 1024 * 1024) })).resolves.toMatchObject({ opId: expect.any(String) });
    });
    it("bounds chunk ordering, reserved bytes and actual encoded message overhead", async () => {
      const [a] = await fresh();
      const ref = await store.attachments.create({ accountId: a!, filename: "file", mime: "text/plain", size: 3, now: 0 });
      await expect(store.attachments.append(a!, ref.assetId, 0, "AQ==")).rejects.toThrow();
      await expect(store.attachments.seal(a!, ref.assetId)).rejects.toThrow();
      const d = (await store.drafts.save(draft(a!, []), 0))!;
      await expect(store.compose.queueSend({ ...send(a!, []), draftId: d.id, bodyText: "界".repeat(7_000_000) })).rejects.toThrow();
      expect(await store.drafts.list()).toHaveLength(1);
      for (let i = 0; i < 14; i++) await store.attachments.create({ accountId: a!, filename: "reserved", mime: "text/plain", size: 18 * 1024 * 1024, now: 0 });
      await expect(store.attachments.create({ accountId: a!, filename: "over quota", mime: "text/plain", size: 18 * 1024 * 1024, now: 0 })).rejects.toThrow();
    });
    it("keeps oversized incoming mail readable without a retry loop, and explicit retry reopens capture", async () => {
      const [a] = await fresh();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "over-limit", attachments: [{ filename: "huge.bin", mime: "application/octet-stream", size: 19 * 1024 * 1024, bytes: new Uint8Array(19 * 1024 * 1024) }] })]);
      const thread = await threadOf(store, "over-limit");
      const message = (await store.threads.get(thread))!.messages[0]!;
      expect(message.bodyText).not.toBeNull();
      expect(message.attachments[0]!.assetId).toBeUndefined();
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toEqual([]);
      await store.attachments.retry(a!, message.id);
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toHaveLength(1);
    });
    it("durably records header-only size refusal without blocking neighbors or erasing cached assets", async () => {
      const [a, b] = await fresh();
      const ref = await upload(a!);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "saved-part", attachments: [ref] })]);
      const cached = await threadOf(store, "saved-part");
      await ingest(store, [msg({ accountId: a!, providerMsgId: "saved-part", bodyState: "partial", bodyText: null, attachments: [], captureUnavailable: "size" })]);
      expect((await store.threads.get(cached))!.messages[0]!.attachments[0]).toMatchObject(ref);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "header-only", bodyState: "partial", bodyText: null, attachments: [], captureUnavailable: "size", locations: [{ mailbox: "INBOX", uid: 8, uidvalidity: 1, flags: [] }] }), msg({ accountId: a!, providerMsgId: "good-neighbor", attachments: [] })]);
      const thread = await threadOf(store, "header-only");
      store = await h.reopen(store);
      const message = (await store.threads.get(thread))!.messages[0]!;
      expect(message).toMatchObject({ bodyUnavailable: "size", bodyState: "partial", bodyText: null });
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toEqual([]);
      expect(await store.providerStore(a!).pendingBodies(50)).toEqual([]);
      await expect(store.attachments.retry(b!, message.id)).rejects.toThrow();
      await store.attachments.retry(a!, message.id);
      expect(await store.providerStore(a!).pendingBodies(50)).toHaveLength(1);
      await store.sync.setBody(message.id, null, null, { now: 1, classifier: null, captureUnavailable: "size" });
      expect(await store.providerStore(a!).pendingBodies(50)).toEqual([]);
      expect((await store.threads.get(thread))!.messages[0]).toMatchObject({ bodyUnavailable: "size", bodyState: "partial" });
    });
    it("retains verified parts at quota when another part cannot be captured, through restart", async () => {
      const [a] = await fresh();
      const first = { filename: "same.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0,255,128]) };
      await ingest(store, [msg({ accountId: a!, providerMsgId: "quota-parts", attachments: [first] })]);
      const thread = await threadOf(store, "quota-parts");
      const original = (await store.threads.get(thread))!.messages[0]!.attachments[0]!;
      for (let i = 0; i < 14; i++) await store.attachments.create({ accountId: a!, filename: "reserved", mime: "text/plain", size: 18 * 1024 * 1024, now: 0 });
      const remaining = 256 * 1024 * 1024 - (3 + 1024) - 14 * (18 * 1024 * 1024 + 1024) - 1024;
      await store.attachments.create({ accountId: a!, filename: "last reservation", mime: "text/plain", size: remaining, now: 0 });
      await ingest(store, [msg({ accountId: a!, providerMsgId: "quota-parts", attachments: [first, { ...first, bytes: new Uint8Array([1,2,3]) }] })]);
      store = await h.reopen(store);
      const parts = (await store.threads.get(thread))!.messages[0]!.attachments;
      expect(parts).toHaveLength(2);
      expect(parts[0]!.assetId).toBe(original.assetId);
      expect(await store.attachments.read(a!, parts[0]!.assetId!, 0)).toBe("AP+A");
      expect(parts[1]!.assetId).toBeUndefined();
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toEqual([]);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "quota-parts", attachments: [{ ...first, filename: "new.bin", bytes: new Uint8Array([1,2,3]) }, first] })]);
      const reordered = (await store.threads.get(thread))!.messages[0]!.attachments;
      expect(reordered[1]!.assetId).toBe(original.assetId);
      expect(await store.attachments.read(a!, reordered[1]!.assetId!, 0)).toBe("AP+A");
    });
    it("retains colliding reordered nine-MiB parts at quota through reopen", async () => {
      const [a] = await fresh();
      const part = (last: number) => {
        const bytes = new Uint8Array(9 * 1024 * 1024); bytes[bytes.length - 1] = last;
        return { filename: "same.bin", mime: "application/octet-stream", size: bytes.length, bytes };
      };
      const first = part(1), second = part(2);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "collision", attachments: [first, second] })]);
      const thread = await threadOf(store, "collision");
      const original = (await store.threads.get(thread))!.messages[0]!.attachments;
      for (let i = 0; i < 13; i++) await store.attachments.create({ accountId: a!, filename: "reserved", mime: "text/plain", size: 18 * 1024 * 1024, now: 0 });
      await store.attachments.create({ accountId: a!, filename: "last", mime: "text/plain", size: 256 * 1024 * 1024 - 15 * 1024 - 252 * 1024 * 1024 - 1024, now: 0 });
      await ingest(store, [msg({ accountId: a!, providerMsgId: "collision", attachments: [part(3), first, second] })]);
      store = await h.reopen(store);
      const parts = (await store.threads.get(thread))!.messages[0]!.attachments;
      expect(parts.map((p) => p.assetId)).toEqual([undefined, ...original.map((p) => p.assetId)]);
      for (const [i, expected] of [first, second].entries()) {
        for (let chunk = 0; chunk < expected.bytes.length / ATTACHMENT_CHUNK; chunk++) {
          const actual = await store.attachments.read(a!, parts[i + 1]!.assetId!, chunk);
          expect(actual).toBe(bytesBase64(expected.bytes.subarray(chunk * ATTACHMENT_CHUNK, (chunk + 1) * ATTACHMENT_CHUNK)));
        }
        await expect(store.attachments.discard(a!, parts[i + 1]!.assetId!)).rejects.toThrow();
        expect(await store.attachments.info(a!, parts[i + 1]!.assetId!)).toBeTruthy();
      }
    });
    it("preserves the prior attachment revision when colliding verification cannot finish safely", async () => {
      const [a] = await fresh();
      const part = (marker: number) => {
        const bytes = new Uint8Array(8 * 1024 * 1024); bytes[bytes.length - ATTACHMENT_CHUNK - 1] = marker;
        return { filename: "same.bin", mime: "application/octet-stream", size: bytes.length, bytes };
      };
      const first = part(1), second = part(2);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "comparison-exhausted", attachments: [first, second] })]);
      const thread = await threadOf(store, "comparison-exhausted");
      const original = (await store.threads.get(thread))!.messages[0]!.attachments;
      await ingest(store, [msg({ accountId: a!, providerMsgId: "comparison-exhausted", attachments: [part(3), part(4), first, second] })]);
      store = await h.reopen(store);
      const current = (await store.threads.get(thread))!.messages[0]!.attachments;
      const revision = (parts: typeof current) => parts.map((p) => [p.assetId, p.filename, p.mime, p.size, p.contentId]);
      expect(revision(current)).toEqual(revision(original));
      for (const [i, expected] of [first, second].entries()) {
        for (let chunk = 0; chunk < Math.ceil(expected.bytes.length / ATTACHMENT_CHUNK); chunk++) {
          expect(await store.attachments.read(a!, current[i]!.assetId!, chunk)).toBe(bytesBase64(expected.bytes.subarray(chunk * ATTACHMENT_CHUNK, (chunk + 1) * ATTACHMENT_CHUNK)));
        }
      }
    });
    it("keeps an incoming message readable when its parts collectively exceed the capture budget", async () => {
      const [a] = await fresh();
      const part = { filename: "ten-megabytes.bin", mime: "application/octet-stream", size: 10 * 1024 * 1024, bytes: new Uint8Array(10 * 1024 * 1024) };
      await ingest(store, [msg({ accountId: a!, providerMsgId: "aggregate-budget", attachments: [part, { ...part, filename: "second.bin" }] })]);
      const thread = await threadOf(store, "aggregate-budget");
      const message = (await store.threads.get(thread))!.messages[0]!;
      expect(message.attachments).toHaveLength(2);
      expect(message.attachments[0]!.assetId).toBeTruthy();
      expect(message.attachments[1]!.assetId).toBeUndefined();
      expect(await store.providerStore(a!).pendingAttachmentBodies(50)).toEqual([]);
    });
    it("accounts reservations exactly through failed cleanup, discard, account cascade and reopen", async () => {
      const [a, b] = await fresh();
      const old = await upload(a!, ""); const other = await upload(b!, "");
      const reservations = [];
      for (let i = 0; i < 14; i++) reservations.push(await store.attachments.create({ accountId: a!, filename: "reserved", mime: "text/plain", size: 18 * 1024 * 1024, now: 0 }));
      reservations.push(await store.attachments.create({ accountId: a!, filename: "remainder", mime: "text/plain", size: 4 * 1024 * 1024 - 16 * 1024, now: 0 }));
      await expect(store.attachments.create({ accountId: a!, filename: "full", mime: "text/plain", size: 0, now: 0 })).rejects.toThrow();
      // Cleanup would free old assets, but the rejected oversized allocation rolls it back.
      await expect(store.attachments.create({ accountId: a!, filename: "invalid", mime: "text/plain", size: 19 * 1024 * 1024, now: 172800000 })).rejects.toThrow();
      store = await h.reopen(store);
      expect(await store.attachments.info(a!, old.assetId)).toMatchObject(old);
      await expect(store.attachments.create({ accountId: a!, filename: "still full", mime: "text/plain", size: 0, now: 0 })).rejects.toThrow();
      await store.attachments.discard(a!, old.assetId);
      const replacement = await store.attachments.create({ accountId: a!, filename: "fits exactly", mime: "text/plain", size: 0, now: 0 });
      await store.attachments.seal(a!, replacement.assetId);
      await expect(store.attachments.create({ accountId: a!, filename: "full again", mime: "text/plain", size: 0, now: 0 })).rejects.toThrow();
      await store.accounts.remove(a!);
      store = await h.reopen(store);
      expect(await store.attachments.info(b!, other.assetId)).toMatchObject(other);
      await store.attachments.discard(b!, other.assetId);
      await store.debug.verify();
    });
    it("cascades account removal through cold chunks while preserving another account", async () => {
      const [a, b] = await fresh();
      const x = await upload(a!); const y = await upload(b!);
      store = await h.reopen(store);
      await store.accounts.remove(a!);
      await expect(store.attachments.info(a!, x.assetId)).rejects.toThrow();
      expect(await store.attachments.read(b!, y.assetId, 0)).toBe("AP+A");
      await store.debug.verify();
    });
  });
}
