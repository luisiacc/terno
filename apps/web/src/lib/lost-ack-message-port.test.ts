import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { expect, it } from "vitest";
import { RpcClient, type RpcMessage, type RpcResponse, type Transport } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { withAccounts } from "@terno/store/conformance";
import type { ProviderRegistry } from "@terno/mail";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { newFields } from "./compose-fields";
import { beginDraftAckRead, beginForwardEmptyOwnerRead, createDraft, draftsSaved, editDraft, endDraftAckRead, flushDraft, forgetDraft, readDraftAck, sealForwardEmptyOwnerRead, setDraftTransport, useDrafts } from "./drafts";

function portTransport(port: MessagePort, intercept?: (message: RpcMessage) => boolean): Transport {
  return {
    send: (message) => { if (!intercept?.(message)) port.postMessage(message); },
    onMessage: (listener) => { port.on("message", listener); return () => { port.off("message", listener); }; },
    onClose: (listener) => { port.on("close", listener); return () => { port.off("close", listener); }; },
    close: () => port.close(),
  };
}

const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Unexpected provider call"); }, verifyImap: unexpected, connectGmail: unexpected };

it("ignores an actual old MessagePort response after replacing the public RPC transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-late-port-"));
  const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", autoSync: false });
  const old = new MessageChannel(), next = new MessageChannel();
  let oldRequest = 0, nextRequest = 0, oldFrame: RpcResponse | undefined, nextFrame: RpcResponse | undefined;
  let oldReady!: () => void, nextReady!: () => void;
  const oldReply = new Promise<void>((resolve) => { oldReady = resolve; });
  const nextReply = new Promise<void>((resolve) => { nextReady = resolve; });
  const oldServer = portTransport(old.port2, (message) => {
    if (message.t === "res" && message.id === oldRequest) { oldFrame = message; oldReady(); return true; }
    return false;
  });
  const nextServer = portTransport(next.port2, (message) => {
    if (message.t === "res" && message.id === nextRequest) { nextFrame = message; nextReady(); return true; }
    return false;
  });
  oldServer.onMessage((m) => { if (m.t === "req" && m.m === "drafts.save" && m.p && typeof m.p === "object" && "bodyText" in m.p && m.p.bodyText === "committed old") oldRequest = m.id; });
  nextServer.onMessage((m) => { if (m.t === "req" && m.m === "drafts.save") nextRequest = m.id; });
  backend.connect(oldServer, { clientId: "old", origin: "renderer" });
  backend.connect(nextServer, { clientId: "replacement", origin: "renderer" });
  const client = new RpcClient(portTransport(old.port1));
  setDraftTransport((method, params) => client.call(method, params as never));
  let key: string | undefined;
  try {
    const [account] = await withAccounts(store);
    key = createDraft(newFields(account!));
    editDraft(key, { bodyText: "baseline" }); await flushDraft(key);
    const baseline = (await client.call("drafts.list", {}))[0]!;
    editDraft(key, { bodyText: "committed old" });
    const oldSave = flushDraft(key); await oldReply;
    expect(oldFrame).toMatchObject({ t: "res", id: oldRequest, ok: true, r: { id: baseline.id, generation: baseline.generation, revision: baseline.revision + 1, bodyText: "committed old" } });
    expect((await client.call("drafts.list", {}))[0]).toMatchObject({ id: baseline.id, revision: baseline.revision + 1, bodyText: "committed old" });
    const oldAdmission = beginDraftAckRead(useDrafts.getState().drafts[key]!);
    expect(oldAdmission.kind).toBe("proof"); if (oldAdmission.kind !== "proof") throw new Error("Missing old proof");
    expect(await draftsSaved(10)).toBe(false);
    client.attach(portTransport(next.port1)); await oldSave;
    expect(readDraftAck(oldAdmission.proof)).toBeUndefined();
    editDraft(key, { bodyText: "current authored" });
    const currentSave = flushDraft(key); await nextReply;
    expect(nextFrame).toMatchObject({ t: "res", id: nextRequest, ok: true, r: { revision: 1, bodyText: "current authored" } });
    if (!nextFrame || !nextFrame.ok) throw new Error("Missing replacement response");
    const replacement = nextFrame.r as { id: number; generation: string; revision: number; bodyText: string };
    expect(replacement.id).not.toBe(baseline.id); expect(replacement.generation).not.toBe(baseline.generation);
    expect((await client.call("drafts.list", {}))).toEqual(expect.arrayContaining([expect.objectContaining(replacement)]));
    expect(nextRequest).not.toBe(oldRequest);
    const pending = useDrafts.getState().drafts[key]!;
    expect(pending).toMatchObject({ id: baseline.id, generation: baseline.generation, revision: baseline.revision, bodyText: "current authored" });
    const currentAdmission = beginDraftAckRead(pending);
    expect(currentAdmission.kind).toBe("proof"); if (currentAdmission.kind !== "proof") throw new Error("Missing current proof");
    const pendingForward = beginForwardEmptyOwnerRead(currentAdmission.proof);
    expect(pendingForward).toBeDefined();
    expect(sealForwardEmptyOwnerRead(pendingForward!)).toBeUndefined();
    expect(await draftsSaved(10)).toBe(false);
    old.port2.postMessage(oldFrame);
    await new Promise<void>((resolve) => old.port1.once("message", () => resolve()));
    expect(useDrafts.getState().drafts[key]).toBe(pending);
    expect(readDraftAck(oldAdmission.proof)).toBeUndefined();
    expect(readDraftAck(pendingForward!)).toBe(pending);
    expect(sealForwardEmptyOwnerRead(pendingForward!)).toBeUndefined();
    expect(await draftsSaved(10)).toBe(false);
    next.port2.postMessage(nextFrame); await currentSave;
    expect(readDraftAck(pendingForward!)).toBeUndefined();
    const saved = useDrafts.getState().drafts[key]!;
    expect(saved).toMatchObject({ revision: 1, bodyText: "current authored", status: "saved" });
    expect(saved.id).not.toBe(baseline.id); expect(saved.generation).not.toBe(baseline.generation);
    const normal = beginDraftAckRead(saved);
    expect(normal.kind).toBe("proof"); if (normal.kind !== "proof") throw new Error("Missing saved proof");
    expect(readDraftAck(normal.proof)).toBe(saved);
    const forward = beginForwardEmptyOwnerRead(normal.proof); expect(forward).toBeDefined();
    const sealed = sealForwardEmptyOwnerRead(forward!); expect(sealed).toBeDefined();
    expect(readDraftAck(sealed!)).toBe(saved); expect(await draftsSaved()).toBe(true); endDraftAckRead(sealed!);
    const rows = await client.call("drafts.list", {});
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: baseline.id, generation: baseline.generation, revision: baseline.revision + 1, bodyText: "committed old" }), expect.objectContaining({ id: saved.id, generation: saved.generation, revision: 1, bodyText: "current authored" })]));
    expect(rows).toHaveLength(2);
  } finally {
    if (key) forgetDraft(key);
    setDraftTransport(async () => null);
    client.close(); old.port1.close(); old.port2.close(); next.port2.close();
    await backend.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
