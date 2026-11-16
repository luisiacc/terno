import { describe, expect, it } from "vitest";
import { mayRelay, relayedAsk, relays } from "./dated-relay";

// fictionalized from round 13 (Theo's Codeforge review request and Linkwell message)
const REVIEW = "@kofi-a requested your review on: brightkite/web#233 feat: offline drafts\n\nStores drafts in IndexedDB and syncs on reconnect.\n\n—\nReply to this email directly or view it on Codeforge.\nYou are receiving this because your review was requested.";
const MESSAGE = 'Ines Duarte · Staff Engineer at Northwind\n\n"Hi Nora, loved your talk. We\'re running a paid workshop on incident reviews in March. Would you be up for leading a session?"\n\nReply on Linkwell\n\nYou\'re receiving Linkwell message notifications. Unsubscribe';

describe("plan 210 (iteration 5, revision 8): a person's ask a service relays", () => {
  it("a named person asking the reader for a concrete thing, in the relay's sentence or its block", () => {
    expect(relayedAsk("[brightkite/web] Review requested: feat: offline drafts (#233)", REVIEW, "Codeforge", "Nora Quill")).toMatchObject({ by: "@kofi-a" });
    expect(relayedAsk("Ines Duarte sent you a message", MESSAGE, "Linkwell", "Nora Quill")).toMatchObject({ by: "Ines Duarte" });
    // es
    expect(relayedAsk("Inés Duarte te envió un mensaje", '"Hola Lucía, ¿te animas a dar un taller pagado sobre diseño de marca en marzo?"\n\nResponder en Linkwell', "Linkwell", "Lucía Romero")).toMatchObject({ by: "Ines Duarte" });
    expect(relayedAsk("Tarea asignada", "Marta Gil te pidió revisar el presupuesto de la campaña de invierno.", "Tablero", "Lucía Romero")).toMatchObject({ by: "Marta Gil" });
  });

  it("a network's own call, a post, a generic invitation, nobody by name, or the service itself: none", () => {
    expect(relayedAsk("Owen posted", "Owen Hale posted: Shipping v2 today!\n\nJoin the conversation", "Linkwell", "Theo Marsh")).toBeNull();
    expect(relayedAsk("People you may know", "People you may know: Owen Hale, Amara Okeke.\n\nGrow your network.", "Linkwell", "Theo Marsh")).toBeNull();
    expect(relayedAsk("Join the conversation", "Join the conversation in Rust Devs. 14 new posts this week.", "Linkwell", "Theo Marsh")).toBeNull();
    expect(relayedAsk("Owen Hale invited you to connect", "Owen Hale invited you to connect on Linkwell.", "Linkwell", "Theo Marsh")).toBeNull();
    expect(relayedAsk("Review requested", "Someone requested your review on brightkite/web#233.", "Codeforge", "Nora Quill")).toBeNull();
    expect(relayedAsk("Linkwell sent you a message", "Linkwell sent you a message: complete your profile?", "Linkwell", "Nora Quill")).toBeNull();
    // a message that asks nothing of the reader
    expect(relayedAsk("Ines Duarte sent you a message", 'Ines Duarte\n\n"Great meeting you at the summit."\n\nReply on Linkwell', "Linkwell", "Nora Quill")).toBeNull();
  });

  it("an ask passes only when it's quoted from the relay's own words; the subject alone tells whether Social mail waits for its body", () => {
    const relay = relayedAsk("Ines Duarte sent you a message", MESSAGE, "Linkwell", "Nora Quill");
    expect(relays(relay, "Would you be up for leading a session?")).toBe(true);
    expect(relays(relay, "Unsubscribe from Linkwell")).toBe(false);
    expect(relays(null, "Would you be up for leading a session?")).toBe(false);
    expect(mayRelay("Daniel Ortiz sent you a message")).toBe(true);
    expect(mayRelay("[pingwire/cli] Review requested: feat: parallel uploads (#812)")).toBe(true);
    expect(mayRelay("Owen posted: Shipping v2 today")).toBe(false);
  });
});
