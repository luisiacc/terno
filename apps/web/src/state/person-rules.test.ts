import { createMemoryTransportPair, RPC_VERSION, RpcClient, type EventName, type Events, type RpcRequest, type Transport } from "@terno/core/rpc";
import type { PersonRule } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", async () => {
  const { RpcClient } = await import("@terno/core/rpc");
  return { client: new RpcClient() };
});
const said: { kind: "success" | "error"; message: string; undoName?: string; undo?: () => unknown }[] = [];
vi.mock("~/lib/snack", () => ({
  snack: Object.assign(() => {}, {
    success: (message: string, o?: { action?: { name: string; undo: () => unknown } }) => void said.push({ kind: "success", message, undoName: o?.action?.name, undo: o?.action?.undo }),
    error: (message: string) => void said.push({ kind: "error", message }),
  }),
  registerUndo: (run: () => unknown) => run,
}));
const { client } = await import("~/rpc/connection");
const { installPersonRules, readPersonRules, usePersonRules } = await import("./person-rules");
const { choosePerson } = await import("~/lib/person-rules");
installPersonRules();

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
    fail: (req: RpcRequest, message: string) => server.send({ v: RPC_VERSION, t: "res", id: req.id, ok: false, e: { code: "BAD_REQUEST", message } }),
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ana: PersonRule = { id: "a", key: "ana@friends.test", email: "ana@friends.test", name: "Ana", person: false, at: 1 };
beforeEach(() => {
  said.length = 0;
  setLocale("en", en);
});
afterEach(() => {
  (client as RpcClient).close();
  for (const t of transports.splice(0)) t.close();
});

it("unread until asked; kept by events; read again on a reconnection; a stale answer never wins over an event", async () => {
  const first = attach();
  await tick();
  expect(first.requests).toEqual([]);
  const read = readPersonRules();
  await tick();
  first.reply(first.requests[0]!, { rules: [] });
  await read;
  expect(usePersonRules.getState().rules).toEqual([]);
  first.event("personRules", { rules: [ana] });
  await tick();
  expect(usePersonRules.getState().rules).toEqual([ana]);
  const second = attach();
  await tick();
  expect(second.requests.map((r) => r.m)).toEqual(["people.rules"]);
  second.event("personRules", { rules: [] });
  await tick();
  second.reply(second.requests[0]!, { rules: [ana] });
  await tick();
  expect(usePersonRules.getState().rules).toEqual([]);
});

it("each choice says what changed, and its Undo asks for exactly what was before, only over its own rule", async () => {
  const s = attach();
  const answer = async (result: unknown) => {
    await tick();
    const req = s.requests.at(-1)!;
    s.reply(req, result);
    return req;
  };
  // Never, over nothing: its Undo takes off that rule only
  let done = choosePerson({ email: "ana@friends.test", name: "Ana" }, "never");
  expect((await answer({ set: ana, prior: null })).p).toEqual({ email: "ana@friends.test", name: "Ana", person: false });
  await done;
  expect(said.at(-1)).toMatchObject({ kind: "success", message: "Ana won’t count as a person", undoName: "Undo the change for Ana" });
  void said.at(-1)!.undo!();
  expect((await answer({ restored: true })).p).toEqual({ email: "ana@friends.test", expect: "a", to: null });
  // Always over Never: its Undo puts Never back as it was
  const always: PersonRule = { ...ana, id: "b", person: true, at: 2 };
  done = choosePerson({ email: "ana@friends.test", name: "" }, "always");
  await answer({ set: always, prior: ana });
  await done;
  expect(said.at(-1)!.message).toBe("ana@friends.test counts as a person now");
  void said.at(-1)!.undo!();
  expect((await answer({ restored: true })).p).toEqual({ email: "ana@friends.test", expect: "b", to: { id: "a", email: "ana@friends.test", name: "Ana", person: false, at: 1 } });
  // Automatically: its Undo puts the rule back only while none is there
  done = choosePerson({ email: "ana@friends.test", name: "Ana" }, "auto");
  expect((await answer({ removed: ana })).m).toBe("people.removeRule");
  await done;
  expect(said.at(-1)!.message).toBe("Terno decides again whether Ana is a person");
  void said.at(-1)!.undo!();
  expect((await answer({ restored: true })).p).toMatchObject({ expect: null, to: { id: "a", person: false } });
  // the same rule already: nothing said, nothing to undo
  const before = said.length;
  done = choosePerson({ email: "ana@friends.test", name: "Ana" }, "never");
  await answer({ set: null, prior: null });
  expect(await done).toBe(true);
  expect(said.length).toBe(before);
  // refused: the backend's words
  done = choosePerson({ email: "over@a.test", name: "" }, "never");
  await tick();
  s.fail(s.requests.at(-1)!, "You’ve already chosen for 500 senders, the most Terno keeps.");
  expect(await done).toBe(false);
  expect(said.at(-1)).toEqual({ kind: "error", message: "You’ve already chosen for 500 senders, the most Terno keeps." });
});

it("Spanish copy", async () => {
  setLocale("es", es);
  const s = attach();
  const done = choosePerson({ email: "ana@friends.test", name: "Ana" }, "never");
  await tick();
  s.reply(s.requests.at(-1)!, { set: ana, prior: null });
  await done;
  expect(said.at(-1)).toMatchObject({ message: "Ana ya no cuenta como persona", undoName: "Deshacer el cambio de Ana" });
});
