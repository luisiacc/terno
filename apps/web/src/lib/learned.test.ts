// @vitest-environment jsdom
/**
 * Plan 159: a learned rule's offer: its condition said one way, whole, in English and Spanish; shown in the Inbox once
 * (seen as it shows, kept for that visit, gone after leaving or a relaunch), answering ends it, Undo brings it back only
 * within the visit, and the seen list is bounded and shared between windows.
 */
import type { LearnedProposal } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}) } }));

const proposal = (key: string, o: Partial<LearnedProposal> = {}): LearnedProposal => ({ key, scope: "domain", value: "daily.morningbrew.com", action: "archive", support: 12, confidence: 1, rule: { match: "all", conditions: [], actions: [] }, ...o }) as LearnedProposal;
const A = proposal("domain:daily.morningbrew.com:archive");
const B = proposal("sender:ana@x.com:trash", { scope: "sender", value: "ana@x.com", action: "trash" });

async function load() {
  vi.resetModules();
  const learned = await import("./learned");
  const app = await import("~/state/app");
  // (the i18n these modules now hold: a reset gives them their own)
  const i18n = await import("@terno/i18n");
  return { ...learned, ...app, setLocale: i18n.setLocale };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en", en);
});
afterEach(() => setLocale("en", en));

describe("the rule's words", () => {
  it("say the condition whole, as the rule reads it, in en and es", async () => {
    const { learnedLine, learnedRule, learnedCreated, learnedWhy, setLocale } = await load();
    setLocale("en", en);
    expect(learnedLine(A)).toBe("Always archive mail from anyone at daily.morningbrew.com?");
    expect(learnedLine(B)).toBe("Always delete mail from ana@x.com?");
    expect(learnedLine(proposal("list:news.x.com:spam", { scope: "list", value: "news.x.com", action: "spam" }))).toBe("Always send mail from the list news.x.com to spam?");
    expect(learnedRule(A)).toBe("Archive mail from anyone at daily.morningbrew.com");
    expect(learnedCreated(A)).toBe("New mail from anyone at daily.morningbrew.com is archived from now on.");
    expect(learnedWhy(A)).toBe("You always archive mail from anyone at daily.morningbrew.com (12 times).");
    setLocale("es", es);
    expect(learnedLine(A)).toBe("¿Archivar siempre el correo de cualquiera en daily.morningbrew.com?");
    expect(learnedRule(B)).toBe("Borrar el correo de ana@x.com");
  });
});

describe("shown once", () => {
  it("is offered until it shows; seen as it shows, it stays for the visit, and leaving the Inbox ends it and the launch's offers", async () => {
    const { useOffer, offerOf, setProposals, noteShown, getApp, navigate } = await load();
    setProposals([A, B]);
    expect(offerOf(useOffer.getState())?.key).toBe(A.key);
    noteShown(A.key, getApp());
    expect(JSON.parse(localStorage.getItem("terno:learned-seen")!)).toEqual([A.key]);
    // seen, and still on screen while you stay
    expect(offerOf(useOffer.getState())?.key).toBe(A.key);
    navigate({ view: "sent", accountId: null });
    expect(offerOf(useOffer.getState())).toBeNull();
    // back in the Inbox: not again, and no other one this launch
    navigate({ view: "inbox", accountId: null });
    expect(offerOf(useOffer.getState())).toBeNull();
  });

  it("a search or another account ends the visit too", async () => {
    const { useOffer, offerOf, setProposals, noteShown, getApp, setApp } = await load();
    setProposals([A]);
    noteShown(A.key, getApp());
    setApp({ query: "x" });
    setApp({ query: "" });
    expect(offerOf(useOffer.getState())).toBeNull();
  });

  it("after a relaunch it isn't offered again; one not seen yet is", async () => {
    let m = await load();
    m.setProposals([A, B]);
    m.noteShown(A.key, m.getApp());
    sessionStorage.clear();
    m = await load();
    m.setProposals([A, B]);
    expect(m.offerOf(m.useOffer.getState())?.key).toBe(B.key);
  });

  it("answering ends it at once; Undo brings it back within the visit, not after it", async () => {
    const { useOffer, offerOf, setProposals, noteShown, getApp, navigate, hush, unhush } = await load();
    setProposals([A, B]);
    noteShown(A.key, getApp());
    hush(true);
    expect(offerOf(useOffer.getState())).toBeNull();
    unhush(A.key);
    expect(offerOf(useOffer.getState())?.key).toBe(A.key);
    hush(true);
    navigate({ view: "sent", accountId: null });
    unhush(A.key);
    expect(offerOf(useOffer.getState())).toBeNull();
  });

  it("keeps the last 200 seen, and another window's seen ones are seen here", async () => {
    const { useOffer, noteShown, getApp, setApp, SEEN_MAX } = await load();
    for (let i = 0; i < SEEN_MAX + 5; i++) {
      noteShown(`k${i}`, getApp());
      // a new visit each time (a place left and come back to)
      setApp({ view: "sent" });
      setApp({ view: "inbox" });
    }
    const kept = JSON.parse(localStorage.getItem("terno:learned-seen")!) as string[];
    expect(kept).toHaveLength(SEEN_MAX);
    expect(kept[0]).toBe("k5");
    localStorage.setItem("terno:learned-seen", JSON.stringify(["other"]));
    window.dispatchEvent(new StorageEvent("storage", { key: "terno:learned-seen" }));
    expect([...useOffer.getState().seen]).toEqual(["other"]);
  });
});
