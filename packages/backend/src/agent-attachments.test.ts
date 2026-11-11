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

/** A thread read the way locateForAgent reads it: one message whose state the test sets, changed by a fake download. */
function fakeBackend(message: Partial<MessageDetail>, thread: Partial<ThreadDetail["thread"]> = {}, afterHydrate?: Partial<MessageDetail>) {
  let current = { id: 7, accountId: 3, attachments: [], attachmentState: "complete", bodyState: "full", ...message } as unknown as MessageDetail;
  let hydrations = 0;
  const b = {
    store: { threads: { get: async () => ({ thread: { inInbox: true, inSpam: false, inTrash: false, ...thread }, messages: [current] }) } },
    hydrateBody: async () => {
      hydrations++;
      if (afterHydrate) current = { ...current, ...afterHydrate };
      return { changed: true };
    },
  } as unknown as Parameters<typeof locateForAgent>[0];
  return { b, hydrations: () => hydrations };
}

const ask = (attachmentId: string, includeSpamTrash = false) => ({ threadId: 1, messageId: 7, attachmentId, includeSpamTrash });
const run = (work: () => Promise<unknown>) => work();
const fails = async (p: Promise<unknown>, message: string) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as Error).message).toBe(message);
};

describe("plan 185: which file an agent asked for", () => {
  it("a kept file by its asset, with its place", async () => {
    const { b } = fakeBackend({ attachments: [part({ assetId: "asset-1" })] });
    expect(await locateForAgent(b, ask("asset-1"), run)).toEqual({ accountId: 3, assetId: "asset-1", filename: "a.pdf", mime: "application/pdf", size: 10, place: "inbox" });
  });

  it("Spam and Trash only when asked: the conversation's place or the message's own", async () => {
    await fails(locateForAgent(fakeBackend({ attachments: [part({ assetId: "x" })] }, { inSpam: true }).b, ask("x"), run), AGENT_ATTACHMENT.spam);
    await fails(locateForAgent(fakeBackend({ isTrash: true, attachments: [part({ assetId: "x" })] }).b, ask("x"), run), AGENT_ATTACHMENT.spam);
    expect((await locateForAgent(fakeBackend({ isSpam: true, attachments: [part({ assetId: "x" })] }).b, ask("x", true), run)).place).toBe("spam");
  });

  it("a file not kept yet: downloads its message once, then finds the same file again by what it is (row ids are reused)", async () => {
    const { b, hydrations } = fakeBackend(
      { bodyState: "partial", attachmentState: "pending", attachments: [part({ id: 5, filename: "b.txt", mime: "text/plain" }), part({ id: 6 })] },
      {},
      // captured again: the rows came back in another order, the ids reused
      { bodyState: "full", attachmentState: "complete", attachments: [part({ id: 5, assetId: "pdf-asset" }), part({ id: 6, filename: "b.txt", mime: "text/plain", assetId: "txt-asset" })] },
    );
    expect((await locateForAgent(b, ask("row-6"), run)).assetId).toBe("pdf-asset");
    expect(hydrations()).toBe(1);
  });

  it("a row id whose file was kept since is stale, never another file", async () => {
    await fails(locateForAgent(fakeBackend({ attachments: [part({ id: 6, assetId: "other" })] }).b, ask("row-6"), run), AGENT_ATTACHMENT.stale);
    await fails(locateForAgent(fakeBackend({ attachments: [] }).b, ask("nope"), run), AGENT_ATTACHMENT.stale);
  });

  it("says why a file has no bytes: too large a message, past the limits, not downloaded yet; no download when it can't help", async () => {
    const tooLarge = fakeBackend({ bodyState: "partial", bodyUnavailable: "size", attachmentState: "unavailable", attachments: [part({ id: 1 })] });
    await fails(locateForAgent(tooLarge.b, ask("row-1"), run), AGENT_ATTACHMENT.messageTooLarge);
    const past = fakeBackend({ attachmentState: "unavailable", attachments: [part({ id: 1 })] });
    await fails(locateForAgent(past.b, ask("row-1"), run), AGENT_ATTACHMENT.notKept);
    // the body is stored but the file wasn't captured: downloading the body again wouldn't bring it
    const pending = fakeBackend({ attachmentState: "pending", attachments: [part({ id: 1 })] });
    await fails(locateForAgent(pending.b, ask("row-1"), run), AGENT_ATTACHMENT.pending);
    expect(tooLarge.hydrations() + past.hydrations() + pending.hydrations()).toBe(0);
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
    const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
    const bytes = new Uint8Array(4000).fill(7);
    await backend.store.sync.ingest([msg({ accountId, providerMsgId: "f", hasAttachments: true, attachments: [{ filename: "a.bin", mime: "application/octet-stream", size: bytes.length, bytes }] })], { applyFilters: false, now: 1, classifier: null });
    const detail = (await backend.store.threads.get((await backend.store.debug.snapshot()).threads[0]!.id))!;
    const message = detail.messages[0]!;
    return { backend, renderer, agent: () => pair("mcp", `agent-${Math.random()}`), accountId, threadId: detail.thread.id, messageId: message.id, assetId: message.attachments[0]!.assetId! };
  }

  it("agents read on their own budget: two agent calls at once, and the user's downloads are never refused for them", async () => {
    const { renderer, agent, accountId, assetId, threadId, messageId } = await setup();
    const read = (c: RpcClient) => c.call("attachments.read", { accountId, assetId, index: 0 });
    const agents = [agent(), agent(), agent()];
    const results = await Promise.allSettled([...agents.map(read), read(renderer), read(renderer)]);
    expect(results.slice(3).every((r) => r.status === "fulfilled")).toBe(true);
    const refused = results.slice(0, 3).filter((r) => r.status === "rejected");
    expect(refused.length).toBeLessThanOrEqual(1);
    for (const r of refused) expect(((r as PromiseRejectedResult).reason as Error).message).toBe(AGENT_ATTACHMENT.busy);
    // the agent calls are the agent's; the rest of the asset calls stay the renderer's
    await expect(renderer.call("attachments.agentLocate", { threadId, messageId, attachmentId: assetId, includeSpamTrash: false })).rejects.toThrow();
    await expect(agents[0]!.call("attachments.create", { accountId, filename: "x", mime: "text/plain", size: 1 })).rejects.toThrow();
    expect(await agents[0]!.call("attachments.agentLocate", { threadId, messageId, attachmentId: assetId, includeSpamTrash: false })).toMatchObject({ assetId, size: 4000, place: "inbox" });
  });

});
