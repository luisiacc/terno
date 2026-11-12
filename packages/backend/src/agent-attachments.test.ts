import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentInfo, MessageDetail, ThreadDetail } from "@terno/core";
import { createMemoryTransportPair, RpcClient, RpcError } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ATTACHMENT, locateForAgent } from "./agent-attachments";
import { Backend, plaintextCipher } from "./backend";

const part = (over: Partial<AttachmentInfo>): AttachmentInfo => ({ id: 1, filename: "a.pdf", mime: "application/pdf", size: 10, contentId: null, ...over });

/** A thread read the way locateForAgent reads it: one message whose state the test sets. */
function fakeBackend(message: Partial<MessageDetail>, thread: Partial<ThreadDetail["thread"]> = {}) {
  const current = { id: 7, accountId: 3, attachments: [], attachmentState: "complete", bodyState: "full", ...message } as unknown as MessageDetail;
  return { store: { threads: { get: async () => ({ thread: { inInbox: true, inSpam: false, inTrash: false, ...thread }, messages: [current] }) } } } as unknown as Parameters<typeof locateForAgent>[0];
}

const ask = (attachmentId: string, includeSpamTrash = false) => ({ threadId: 1, messageId: 7, attachmentId, includeSpamTrash });
const fails = async (p: Promise<unknown>, message: string) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as Error).message).toBe(message);
};

describe("plan 185: which file an agent asked for", () => {
  it("a kept file by its asset, with its place", async () => {
    expect(await locateForAgent(fakeBackend({ attachments: [part({ assetId: "asset-1" })] }), ask("asset-1"))).toEqual({ accountId: 3, assetId: "asset-1", filename: "a.pdf", mime: "application/pdf", size: 10, place: "inbox" });
  });

  it("Spam and Trash only when asked: the conversation's place or the message's own", async () => {
    await fails(locateForAgent(fakeBackend({ attachments: [part({ assetId: "x" })] }, { inSpam: true }), ask("x")), AGENT_ATTACHMENT.spam);
    await fails(locateForAgent(fakeBackend({ isTrash: true, attachments: [part({ assetId: "x" })] }), ask("x")), AGENT_ATTACHMENT.spam);
    expect((await locateForAgent(fakeBackend({ isSpam: true, attachments: [part({ assetId: "x" })] }), ask("x", true))).place).toBe("spam");
  });

  it("an id that isn't a kept file of that message is stale: never a row id, never another message's asset", async () => {
    await fails(locateForAgent(fakeBackend({ attachments: [part({ id: 6 })] }), ask("row-6")), AGENT_ATTACHMENT.stale);
    await fails(locateForAgent(fakeBackend({ attachments: [part({ assetId: "mine" })] }), ask("someone-else")), AGENT_ATTACHMENT.stale);
  });
});

describe("plan 185: the backend's agent file calls", () => {
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) await s();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join("/tmp", "tagatt-"));
    dirs.push(dir);
    const backend = new Backend({ dbPath: join(dir, "t.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, agentEndpoint: { socketPath: join(dir, "a.sock"), tokenPath: join(dir, "a.token") } });
    stops.push(() => backend.stop().catch(() => {}));
    await backend.store.ready;
    const pair = (origin: "renderer" | "mcp", clientId: string) => {
      const [c, s] = createMemoryTransportPair();
      backend.connect(s, { clientId, origin });
      return new RpcClient(c);
    };
    const renderer = pair("renderer", "renderer");
    await renderer.call("settings.update", { agents: { enabled: true, access: "read" } });
    const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "brown" }).id;
    const bytes = new Uint8Array(4000).fill(7);
    await backend.store.sync.ingest([msg({ accountId, providerMsgId: "f", hasAttachments: true, attachments: [{ filename: "a.bin", mime: "application/octet-stream", size: bytes.length, bytes }] })], { applyFilters: false, now: 1, classifier: null });
    const detail = (await backend.store.threads.get((await backend.store.debug.snapshot()).threads[0]!.id))!;
    const message = detail.messages[0]!;
    return { backend, renderer, agent: () => pair("mcp", `agent-${Math.random()}`), accountId, threadId: detail.thread.id, messageId: message.id, assetId: message.attachments[0]!.assetId! };
  }

  it("agents read on their own budget: at most two calls at once, and the user's downloads are never refused for them", async () => {
    const { backend, renderer, agent, accountId, assetId, threadId, messageId } = await setup();
    // two agent calls held mid-way
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const get = backend.store.threads.get.bind(backend.store.threads);
    let held = 0;
    backend.store.threads.get = (async (...args: Parameters<typeof get>) => {
      if (held < 2) {
        held++;
        await gate;
      }
      return get(...args);
    }) as typeof get;
    const locate = (c: RpcClient) => c.call("attachments.agentLocate", { threadId, messageId, attachmentId: assetId, includeSpamTrash: false });
    const first = [locate(agent()), locate(agent())];
    while (held < 2) await new Promise((r) => setTimeout(r, 1));
    await expect(locate(agent())).rejects.toThrow(AGENT_ATTACHMENT.busy);
    await expect(agent().call("attachments.read", { accountId, assetId, index: 0 })).rejects.toThrow(AGENT_ATTACHMENT.busy);
    // the user's downloads go on
    expect((await renderer.call("attachments.read", { accountId, assetId, index: 0 })).dataBase64).toEqual(expect.any(String));
    release();
    for (const r of await Promise.all(first)) expect(r).toMatchObject({ assetId, size: 4000, place: "inbox" });
    // the agent calls are the agent's; the rest of the asset calls stay the renderer's
    await expect(renderer.call("attachments.agentLocate", { threadId, messageId, attachmentId: assetId, includeSpamTrash: false })).rejects.toThrow();
    await expect(agent().call("attachments.create", { accountId, filename: "x", mime: "text/plain", size: 1 })).rejects.toThrow();
  });

});
