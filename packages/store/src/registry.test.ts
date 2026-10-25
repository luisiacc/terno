import { setLocale, translate, type Localized } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
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
    expect(await r.pick({ name: "terno" })).toMatchObject({ adapter: { id: "idb" }, reason: "default" });
  });

  it("never picks a non-automatic adapter on its own, but honors an explicit request", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb", { automatic: false }));
    expect(await r.pick({ name: "terno" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(await r.pick({ name: "terno", requested: "idb" })).toMatchObject({ adapter: { id: "idb" }, reason: "requested" });
  });

  it("opens an existing mailbox where it lives", async () => {
    const r = new StoreRegistry().register(adapter("opfs")).register(adapter("idb", { exists: true, automatic: false }));
    expect(await r.pick({ name: "terno" })).toMatchObject({ adapter: { id: "idb" }, reason: "existing" });
  });

  it("an unavailable pinned or requested adapter is an error, never a silent switch to an empty mailbox elsewhere", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb"));
    expect(await r.pick({ name: "terno", pinned: "opfs" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(await r.pick({ name: "terno", requested: "nope", pinned: "idb" })).toMatchObject({ adapter: null, reason: "unavailable" });
    expect(() => r.register(adapter("idb"))).toThrow(/already registered/);
  });

  it("says why as catalog messages (the web's open-error screen shows them in the user's language)", async () => {
    const r = new StoreRegistry().register(adapter("opfs", { available: false })).register(adapter("idb", { available: false }));
    expect(await r.pick({ name: "terno", requested: "nope" })).toMatchObject({
      message: { key: "web.storage.unknownEngine", params: { id: "nope", known: "opfs, idb" }, message: "There’s no storage engine called “nope” (this browser has: opfs, idb)." },
    });
    expect(await r.pick({ name: "terno", pinned: "opfs" })).toMatchObject({ message: { key: "web.storage.engineMissing", message: "opfs isn’t available in this browser." } });
    const none = await r.pick({ name: "terno" });
    expect(none).toMatchObject({ message: { key: "web.storage.noEngine" } });
    setLocale("es", es);
    expect(translate((none as { message: Localized }).message)).toBe("Este navegador no tiene ni OPFS ni IndexedDB, donde Terno guarda tu correo.");
    setLocale("en", en);
  });
});
