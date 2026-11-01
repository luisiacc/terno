import type { ThreadDetail, MessageDetail } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ call: vi.fn(), connectionVersion: 1 }));
vi.mock("~/rpc/connection", () => ({ client: rpc }));
const { hydrateSelectedThread, useThreads } = await import("./threads");
const { useSnack } = await import("~/lib/snack");
let detail: ThreadDetail;
let requests: number[];
const message = (id: number) => ({ id, threadId: 1, accountId: 3, bodyState: "partial", bodyText: null, bodyHtml: null, attachments: [] }) as unknown as MessageDetail;
beforeEach(() => {
  detail = { thread: { id: 1, accountId: 3 }, messages: [message(101), message(102)] } as unknown as ThreadDetail;
  requests = [];
  useThreads.setState({ details: new Map([[1, detail]]), gone: new Set(), version: 0 });
  rpc.call.mockReset();
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "threads.get") return detail;
    if (method !== "reader.hydrate") throw new Error("Unexpected RPC");
    requests.push(params.messageId);
    if (params.messageId === 101) return { changed: false, unavailable: true };
    detail = { ...detail, messages: detail.messages.map((m) => m.id === 102 ? { ...m, bodyState: "full", bodyText: "Exact latest body", attachments: [] } : m) };
    return { changed: true };
  });
});

it("continues past an unavailable oldest message and retries only that identity", async () => {
  await hydrateSelectedThread(1, () => true);
  expect(requests).toEqual([101, 102]);
  expect(useThreads.getState().details.get(1)!.messages[1]!.bodyText).toBe("Exact latest body");
  const retry = useSnack.getState().current!.action!.onClick!;
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "threads.get") return detail;
    requests.push(params.messageId);
    return { changed: false, unavailable: true };
  });
  retry();
  await vi.waitFor(() => expect(requests).toEqual([101, 102, 101]));
});

it.each(["auth", "quota"])("stops account-wide work on %s and ignores a stale retry", async (reason) => {
  let selected = true;
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "threads.get") return detail;
    requests.push(params.messageId);
    throw new RpcError("UNAVAILABLE", reason);
  });
  await hydrateSelectedThread(1, () => selected);
  expect(requests).toEqual([101]);
  selected = false;
  useSnack.getState().current!.action!.onClick!();
  expect(requests).toEqual([101]);
});

it("does not request another message after the connection changes", async () => {
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "threads.get") return detail;
    requests.push(params.messageId); rpc.connectionVersion++;
    return { changed: false, unavailable: true };
  });
  await hydrateSelectedThread(1, () => true);
  expect(requests).toEqual([101]);
});
