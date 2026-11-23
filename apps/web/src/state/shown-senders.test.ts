import { createMemoryTransportPair, RPC_VERSION, RpcClient, type EventName, type Events, type RpcRequest, type Transport } from "@terno/core/rpc";
import type { ShownSender } from "@terno/core";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", async () => {
  const { RpcClient } = await import("@terno/core/rpc");
  return { client: new RpcClient() };
});
const { client } = await import("~/rpc/connection");
const { installShownSenders, readShownSenders, useShownSenders } = await import("./shown-senders");
installShownSenders();

const transports: Transport[] = [];
function attach() {
  const [renderer, server] = createMemoryTransportPair();
  transports.push(renderer, server);
  const requests: RpcRequest[] = [];
  server.onMessage((m) => void (m.t === "req" && requests.push(m)));
  (client as RpcClient).attach(renderer);
  return {
    requests,
    event: <E extends EventName>(event: E, payload: Events[E]) => server.send({ v: RPC_VERSION, t: "evt", e: event, p: payload }),
    reply: (req: RpcRequest, result: unknown) => server.send({ v: RPC_VERSION, t: "res", id: req.id, ok: true, r: result }),
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const esof: ShownSender = { id: "e", key: "casa@tacsecurity.test", email: "casa@tacsecurity.test", name: "ESOF", at: 1 };
afterEach(() => {
  (client as RpcClient).close();
  for (const t of transports.splice(0)) t.close();
});

it("plan 240 (Codex code review): unread until asked; kept by events; read again on a reconnection, where one may have been missed; a stale answer never wins over an event", async () => {
  const first = attach();
  await tick();
  // nothing read before a menu asks
  expect(first.requests).toEqual([]);
  const read = readShownSenders();
  await tick();
  first.reply(first.requests[0]!, { senders: [] });
  await read;
  expect(useShownSenders.getState().senders).toEqual([]);
  first.event("shownSenders", { senders: [esof] });
  await tick();
  expect(useShownSenders.getState().senders).toEqual([esof]);
  // another window stopped it while this one was away: the reconnection reads again
  const second = attach();
  await tick();
  expect(second.requests.map((r) => r.m)).toEqual(["today.shownSenders"]);
  // an event after the read left is newer than its answer
  second.event("shownSenders", { senders: [] });
  await tick();
  second.reply(second.requests[0]!, { senders: [esof] });
  await tick();
  expect(useShownSenders.getState().senders).toEqual([]);
});
