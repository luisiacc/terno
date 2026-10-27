import { afterEach, expect, it, vi } from "vitest";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
vi.mock("~/lib/appearance", () => ({ adoptSettings: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("test transport only")) } }));
const { attachBody, copyDraft, createDraft, discardDraft, draftsSaved, editDraft, fieldsOf, forgetDraft, markDraftMissing, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { switchStorage } = await import("./connect");

afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); vi.unstubAllGlobals(); });

it.each(["missing", "ordinary edit", "coalesced body", "new draft", "discard"] as const)("a storage export cannot replace work changed after its save check: %s", async (change) => {
  let id = 10;
  setDraftTransport(async (_method, p) => ({ ...(p as object), id: id++, revision: 1 }));
  const key = createDraft(newFields(1)); editDraft(key, { bodyText: "before", bodyHtml: "<div><b>before</b></div>", toText: "exact unfinished@" }); await draftsSaved();
  let body = "before";
  const source = attachBody(key, () => ({ html: `<div><b>${body}</b></div>`, text: body }));
  if (change === "coalesced body") { body = "pending first"; source.changed(); }
  const replace = vi.fn(), carry = vi.fn(), pin = vi.fn();
  vi.stubGlobal("location", { href: "https://synthetic.test/?storage=opfs-sqlite", replace });
  vi.stubGlobal("sessionStorage", { setItem: carry }); vi.stubGlobal("localStorage", { setItem: pin });
  const [page, backend] = createMemoryTransportPair(); const client = new RpcClient(page);
  let release!: () => void, reached!: () => void;
  const started = new Promise<void>((r) => { reached = r; });
  backend.onMessage((request) => {
    if (request.t !== "req") return;
    const snapshot = { drafts: [fieldsOf(useDrafts.getState().drafts[key]!)] };
    release = () => backend.send({ v: 1, t: "res", id: request.id, ok: true, r: snapshot }); reached();
  });
  const switching = switchStorage(client, "idb"); const verdict = switching.then(() => "switched", () => "held");
  await started;
  if (change === "missing") markDraftMissing(key);
  else if (change === "ordinary edit") editDraft(key, { bodyText: "latest exact" });
  else if (change === "coalesced body") { body = "latest rich"; source.changed(); source.changed(); }
  else if (change === "new draft") createDraft(newFields(1));
  else await discardDraft(key);
  release(); expect(await verdict).toBe("held");
  expect(replace).not.toHaveBeenCalled(); expect(carry).not.toHaveBeenCalled(); expect(pin).not.toHaveBeenCalled();
  if (change === "missing") await copyDraft(key);
  if (change !== "discard") {
    // A deliberate retry exports the current fields afresh, never the held snapshot.
    const retry = switchStorage(client, "idb");
    await vi.waitUntil(() => client.pendingCount === 1); release(); await retry;
    expect(JSON.parse(carry.mock.calls[0]![1]).dump.drafts[0]).toMatchObject({ toText: "exact unfinished@", bodyText: change === "ordinary edit" ? "latest exact" : change === "coalesced body" ? "latest rich" : "before" });
    expect(replace).toHaveBeenCalledTimes(1);
  }
  source.dispose(); client.close();
});
