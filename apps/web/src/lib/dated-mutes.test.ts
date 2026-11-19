/** Plan 210 (iteration 4, the owner's "Mute this kind/sender"; iteration 5's narrow offer): Remove's offer, the mute's own Undo, Unmute's, in en and es. */
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

const { about, mute, muteAddress, muteName, muteOfferAction, offerLabel, unmute, wholeKindsLeft } = await import("./dated-mutes");
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
  it("says what it offers: a kind from its sender, or an automated sender alone, by name (en, es)", () => {
    expect(offerLabel({ on: "pair", key: "delivery|track@parcelo.test", kind: "delivery", name: "Parcelo" })).toBe("Don’t show deliveries from Parcelo");
    expect(offerLabel({ on: "sender", key: "track@parcelo.test", name: "Parcelo" })).toBe("Don’t show anything from Parcelo");
    // no name: the address
    expect(offerLabel({ on: "pair", key: "pay|billing@power.test", kind: "pay", name: "" })).toBe("Don’t show bills from billing@power.test");
    expect(offerLabel({ on: "sender", key: "track@parcelo.test", name: "" })).toBe("Don’t show anything from track@parcelo.test");
    // the claims ledger's second batch: a long name whole on the offer's own line; one longer still cut, only the name
    expect(offerLabel({ on: "pair", key: "delivery|cs@amazon.test", kind: "delivery", name: "Amazon.com Customer Service" })).toBe("Don’t show deliveries from Amazon.com Customer Service");
    expect(offerLabel({ on: "pair", key: "event|events@grace.test", kind: "event", name: "Ingrid Vasquez-Lund (via Calendar)" })).toBe("Don’t show events from Ingrid Vasquez-Lund (via Calendar)");
    expect(offerLabel({ on: "pair", key: "pay|ar@city.test", kind: "pay", name: "City of Millbrook Department of Public Utilities Billing" })).toBe("Don’t show bills from City of Millbrook Department of Public Utilitie…");
    // the list: a kind whole, a pair by both, the address beside a name and never twice
    expect(muteName({ on: "kind", key: "pay", name: "" })).toBe("Bills");
    expect(muteName({ on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" })).toBe("Deliveries from Parcelo");
    expect(muteAddress({ on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" })).toBe("track@parcelo.test");
    expect(muteName({ on: "pair", key: "delivery|track@parcelo.test", name: "" })).toBe("Deliveries from track@parcelo.test");
    expect(muteAddress({ on: "pair", key: "delivery|track@parcelo.test", name: "" })).toBeNull();
    expect(muteAddress({ on: "kind", key: "pay", name: "" })).toBeNull();
    expect(about({ on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" }, "done")).toBe("You won’t see deliveries from Parcelo in “What matters”");
    // the claims ledger's second batch: a calendar service's invitations by the service, never the person they're from
    expect(offerLabel({ on: "pair", key: "event|calendar-noreply@halvorsen.edu", kind: "event", name: "halvorsen.edu", service: "halvorsen.edu" })).toBe("Don’t show events from halvorsen.edu Calendar");
    setLocale("es", es);
    try {
      expect(offerLabel({ on: "pair", key: "event|calendar@uni.edu", kind: "event", name: "uni.edu", service: "uni.edu" })).toBe("No mostrar eventos de Calendario de uni.edu");
      expect(offerLabel({ on: "pair", key: "event|calendar-noreply@halvorsen.edu", kind: "event", name: "halvorsen.edu", service: "halvorsen.edu" })).toBe("No mostrar eventos de Calendario de halvorsen.edu");
      expect(offerLabel({ on: "pair", key: "delivery|track@parcelo.test", kind: "delivery", name: "Parcelo" })).toBe("No mostrar entregas de Parcelo");
      expect(offerLabel({ on: "sender", key: "track@parcelo.test", name: "Parcelo" })).toBe("No mostrar nada de Parcelo");
      expect(muteName({ on: "kind", key: "event", name: "" })).toBe("Eventos");
      expect(muteName({ on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" })).toBe("Entregas de Parcelo");
      expect(about({ on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" }, "unmuted")).toBe("Volverás a ver entregas de Parcelo en «Lo importante»");
    } finally {
      setLocale("en", en);
    }
  });

  it("Settings hides only whole kinds not hidden yet, never a person's requests", () => {
    expect(wholeKindsLeft(null)).toEqual(["pay", "renew", "expire", "alert", "event", "delivery"]);
    expect(wholeKindsLeft([{ on: "kind", key: "pay", name: "" }, { on: "pair", key: "delivery|track@parcelo.test", name: "" }])).toEqual(["renew", "expire", "alert", "event", "delivery"]);
  });

  it("Remove's snack carries the offer as its quiet second button beside Undo; nothing offered, none", async () => {
    const item = { id: 30, revision: 2, kind: "delivery" as const, dueDay: "2026-11-12", timed: false, dated: true };
    answers = { "dated.act": { undoId: "t1" }, "dated.muteOffer": { offer: { on: "pair", key: "delivery|track@parcelo.test", kind: "delivery", name: "Parcelo" } } };
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0, text: "Package arrives" }, "dismiss");
    expect(calls.map((c) => c.method)).toEqual(["dated.act", "dated.muteOffer"]);
    expect(calls[1]!.p).toEqual({ id: 30 });
    expect(said[0]).toMatchObject({ text: "Removed", description: "Package arrives", action: { label: "Undo" }, secondary: { label: "Don’t show deliveries from Parcelo", below: true } });
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
    expect(said[0]).toMatchObject({ text: "Nothing from Parcel Co will show in “What matters”", action: { label: "Undo", name: "Show Parcel Co in “What matters” again" } });
    await said[0]!.action!.undo!.run();
    expect(calls[1]).toEqual({ method: "dated.unmute", p: { on: "sender", key: "track@parcel.test" } });
    answers["dated.mute"] = { mute: { on: "kind", key: "delivery", name: "", at: 6 } };
    await mute({ on: "kind", key: "delivery" });
    expect(said[1]!.text).toBe("You won’t see deliveries in “What matters”");
    // a pair: the offer's key and name, its own Undo unmuting that pair only
    answers["dated.mute"] = { mute: { on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo", at: 7 } };
    await mute({ on: "pair", key: "delivery|track@parcelo.test", kind: "delivery", name: "Parcelo" });
    expect(calls[3]).toEqual({ method: "dated.mute", p: { on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" } });
    expect(said[2]).toMatchObject({ text: "You won’t see deliveries from Parcelo in “What matters”", action: { label: "Undo", name: "Show deliveries from Parcelo in “What matters” again" } });
    await said[2]!.action!.undo!.run();
    expect(calls[4]).toEqual({ method: "dated.unmute", p: { on: "pair", key: "delivery|track@parcelo.test" } });
    failing = "dated.mute";
    await mute({ on: "kind", key: "pay" });
    expect(said[3]).toEqual({ text: "What matters already hides 200 senders and kinds.", tone: "error" });
  });

  it("Unmute says so with Undo that hides it again where it was (en, es)", async () => {
    const m = { on: "kind" as const, key: "delivery", name: "", at: 7 };
    answers = { "dated.unmute": { mute: m } };
    expect(await unmute(m)).toBe(true);
    expect(said[0]).toMatchObject({ text: "You’ll see deliveries in “What matters” again", action: { name: "Hide deliveries again" } });
    await said[0]!.action!.undo!.run();
    expect(calls[1]).toEqual({ method: "dated.mute", p: { on: "kind", key: "delivery", name: "", at: 7 } });
    setLocale("es", es);
    try {
      expect(await unmute(m)).toBe(true);
      expect(said[1]!.text).toBe("Volverás a ver entregas en «Lo importante»");
    } finally {
      setLocale("en", en);
    }
    // a pair: Undo puts that pair back where it was
    const pair = { on: "pair" as const, key: "delivery|track@parcelo.test", name: "Parcelo", at: 8 };
    answers = { "dated.unmute": { mute: pair } };
    expect(await unmute(pair)).toBe(true);
    expect(said[2]).toMatchObject({ text: "You’ll see deliveries from Parcelo in “What matters” again", action: { name: "Hide deliveries from Parcelo again" } });
    await said[2]!.action!.undo!.run();
    expect(calls.at(-1)).toEqual({ method: "dated.mute", p: { on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo", at: 8 } });
    failing = "dated.unmute";
    expect(await unmute(m)).toBe(false);
  });
});
