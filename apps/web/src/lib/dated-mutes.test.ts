/** Plan 210 (iteration 4, the owner's "Mute this kind/sender"): Remove's offer, the mute's own Undo, Unmute's, in en and es. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; p: Record<string, unknown> }[] = [];
let answers: Record<string, unknown> = {};
let failing: string | null = null;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, p: Record<string, unknown>) => {
      calls.push({ method, p });
      return method === failing ? Promise.reject(new Error("What matters already hides 200 senders and kinds.")) : Promise.resolve(answers[method] ?? {});
    },
    on: () => () => {},
  },
}));
interface Said { text: string; tone: "success" | "error"; action?: { label: string; name?: string; undo?: { run: () => unknown } }; secondary?: { label: string; onClick?: () => void } }
const said: Said[] = [];
vi.mock("~/lib/snack", () => ({
  registerUndo: (run: () => unknown) => ({ run, state: "ready" }),
  snack: { success: (text: string, o: Omit<Said, "text" | "tone"> = {}) => said.push({ text, tone: "success", ...o }), error: (text: string) => said.push({ text, tone: "error" }) },
}));

const { mute, muteName, muteOfferAction, offerLabel, unmute } = await import("./dated-mutes");
const { actOnTask } = await import("./dated");
const { setLocale } = await import("@terno/i18n");
const { default: en } = await import("@terno/i18n/locales/en");
const { default: es } = await import("@terno/i18n/locales/es");

beforeEach(() => {
  calls.length = 0;
  said.length = 0;
  answers = {};
  failing = null;
});

describe("Mute (plan 210, iteration 4)", () => {
  it("says what it offers, a kind by its words and a sender by name (en, es)", () => {
    expect(offerLabel({ on: "kind", key: "delivery" })).toBe("Don’t show deliveries");
    expect(offerLabel({ on: "sender", key: "track@parcel.test", name: "Parcel Co" })).toBe("Don’t show Parcel Co");
    // no name: the address
    expect(offerLabel({ on: "sender", key: "track@parcel.test", name: "" })).toBe("Don’t show track@parcel.test");
    expect(muteName({ on: "kind", key: "pay", name: "" })).toBe("Bills");
    // a long name is cut, so the snack keeps room for its message and Undo
    expect(offerLabel({ on: "sender", key: "cs@amazon.test", name: "Amazon.com Customer Service" })).toBe("Don’t show Amazon.com Customer Ser…");
    setLocale("es", es);
    try {
      expect(offerLabel({ on: "kind", key: "delivery" })).toBe("No mostrar entregas");
      expect(offerLabel({ on: "sender", key: "track@parcel.test", name: "Parcel Co" })).toBe("No mostrar a Parcel Co");
      expect(muteName({ on: "kind", key: "event", name: "" })).toBe("Eventos");
    } finally {
      setLocale("en", en);
    }
  });

  it("Remove's snack carries the offer as its quiet second button beside Undo; nothing offered, none", async () => {
    const item = { id: 30, revision: 2, kind: "delivery" as const, dueDay: "2026-11-12", timed: false, dated: true };
    answers = { "dated.act": { undoId: "t1" }, "dated.muteOffer": { offer: { on: "kind", key: "delivery" } } };
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0, text: "Package arrives" }, "dismiss");
    expect(calls.map((c) => c.method)).toEqual(["dated.act", "dated.muteOffer"]);
    expect(calls[1]!.p).toEqual({ id: 30 });
    expect(said[0]).toMatchObject({ text: "Removed from What matters", description: "Package arrives", action: { label: "Undo" }, secondary: { label: "Don’t show deliveries" } });
    // Done and Later never ask
    calls.length = 0;
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0 }, "done");
    expect(calls.map((c) => c.method)).toEqual(["dated.act"]);
    // an offer that can't be read is no error: the Remove went through
    failing = "dated.muteOffer";
    expect(await muteOfferAction(30)).toBeUndefined();
    answers["dated.muteOffer"] = { offer: null };
    failing = null;
    expect(await muteOfferAction(30)).toBeUndefined();
  });

  it("muting says so with its own Undo, which unmutes; at the bound the backend's words are said", async () => {
    answers = { "dated.mute": { mute: { on: "sender", key: "track@parcel.test", name: "Parcel Co", at: 5 } } };
    await mute({ on: "sender", key: "track@parcel.test", name: "Parcel Co" });
    expect(calls[0]).toEqual({ method: "dated.mute", p: { on: "sender", key: "track@parcel.test", name: "Parcel Co" } });
    expect(said[0]).toMatchObject({ text: "Nothing from Parcel Co will show in What matters", action: { label: "Undo", name: "Show Parcel Co in What matters again" } });
    await said[0]!.action!.undo!.run();
    expect(calls[1]).toEqual({ method: "dated.unmute", p: { on: "sender", key: "track@parcel.test" } });
    answers["dated.mute"] = { mute: { on: "kind", key: "delivery", name: "", at: 6 } };
    await mute({ on: "kind", key: "delivery" });
    expect(said[1]!.text).toBe("You won’t see deliveries in What matters");
    failing = "dated.mute";
    await mute({ on: "kind", key: "pay" });
    expect(said[2]).toEqual({ text: "What matters already hides 200 senders and kinds.", tone: "error" });
  });

  it("Unmute says so with Undo that hides it again where it was (en, es)", async () => {
    const m = { on: "kind" as const, key: "delivery", name: "", at: 7 };
    answers = { "dated.unmute": { mute: m } };
    expect(await unmute(m)).toBe(true);
    expect(said[0]).toMatchObject({ text: "You’ll see deliveries in What matters again", action: { name: "Hide deliveries again" } });
    await said[0]!.action!.undo!.run();
    expect(calls[1]).toEqual({ method: "dated.mute", p: { on: "kind", key: "delivery", name: "", at: 7 } });
    setLocale("es", es);
    try {
      expect(await unmute(m)).toBe(true);
      expect(said[1]!.text).toBe("Volverás a ver entregas en Lo importante");
    } finally {
      setLocale("en", en);
    }
    failing = "dated.unmute";
    expect(await unmute(m)).toBe(false);
  });
});
