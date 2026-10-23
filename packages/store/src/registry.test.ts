import { describe, expect, it } from "vitest";
import type { MailStore } from "./mail-store";
import { StoreRegistry, type StoreAdapter } from "./registry";

function adapter(id: string, o: { available?: boolean; exists?: boolean; automatic?: boolean } = {}): StoreAdapter {
  return {
    id,
    label: id,
    automatic: o.automatic ?? true,
    available: async () => o.available ?? true,
    exists: async () => o.exists ?? false,
    open: async () => ({}) as MailStore,
  };
}

describe("StoreRegistry.pick", () => {
  it("prefers the first available automatic adapter for a new mailbox", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb")).register(adapter("extra"));
    expect(await r.pick({ name: "unica" })).toMatchObject({ adapter: { id: "idb" }, reason: "default" });
  });

  it("never picks a non-automatic adapter on its own, but honors an explicit request", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb", { automatic: false }));
    expect(await r.pick({ name: "unica" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(await r.pick({ name: "unica", requested: "idb" })).toMatchObject({ adapter: { id: "idb" }, reason: "requested" });
  });

  it("opens an existing mailbox where it lives", async () => {
    const r = new StoreRegistry().register(adapter("opfs")).register(adapter("idb", { exists: true, automatic: false }));
    expect(await r.pick({ name: "unica" })).toMatchObject({ adapter: { id: "idb" }, reason: "existing" });
  });

  it("an unavailable pinned or requested adapter is an error, never a silent switch to an empty mailbox elsewhere", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb"));
    expect(await r.pick({ name: "unica", pinned: "opfs" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(await r.pick({ name: "unica", requested: "nope", pinned: "idb" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(() => r.register(adapter("idb"))).toThrow(/already registered/);
  });
});
