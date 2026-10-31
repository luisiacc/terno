// @vitest-environment jsdom
import { createMemoryTransportPair, RPC_VERSION, type RpcRequest, type Transport } from "@terno/core/rpc";
import type { ThreadSummary } from "@terno/core";
import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), requestAnimationFrame: () => 0 });
});
vi.mock("~/rpc/connection", async () => {
  const { RpcClient } = await import("@terno/core/rpc");
  return { client: new RpcClient() };
});
const { client } = await import("./connection");
const { act } = await import("~/lib/actions");
const { setApp } = await import("~/state/app");
const { useList } = await import("~/state/list");
const { resetSnacks, useSnack } = await import("~/lib/snack");
const transports: Transport[] = [];
function attach() {
  const [c, s] = createMemoryTransportPair(); transports.push(c, s);
  const requests: RpcRequest[] = [];
  s.onMessage((m) => { if (m.t === "req") requests.push(m); });
  client.attach(c);
  return { requests, reply: (req: RpcRequest) => s.send({ v: RPC_VERSION, t: "res", id: req.id, ok: true, r: { undoId: 12 } }) };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(async () => { client.close(); await tick(); for (const t of transports.splice(0)) t.close(); resetSnacks(); expect(client.pendingCount).toBe(0); });
it.each(["pending", "received"] as const)("a %s old action ACK cannot trigger recovery work or settle newer user work", async (phase) => {
  const old = attach();
  setApp({ selectedId: null, checked: new Set(), scope: null });
  const row = { id: 901, accountId: 1, starred: false, unread: true, categoryIds: [] } as unknown as ThreadSummary;
  useList.setState({ items: [row], index: new Map([[901, 0]]) });
  const first = act("star", [901], { quiet: true }); await tick();
  if (phase === "received") { old.reply(old.requests[0]!); await Promise.resolve(); }
  const replacement = attach();
  const second = act("unstar", [901], { quiet: true }); await tick();
  await first;
  try {
  expect(replacement.requests.map((r) => [r.m, r.p])).toEqual([["threads.act", { threadIds: [901], action: "unstar" }]]);
  expect(useList.getState().items[0]?.starred).toBe(false);
  expect(useSnack.getState().current).toBeNull();
  } finally { replacement.reply(replacement.requests[0]!); await second; }
  expect(useList.getState().items[0]?.starred).toBe(false);
});
