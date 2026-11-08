// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const rpc = vi.hoisted(() => ({ call: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({})) }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call, on: () => () => {}, connectionVersion: 1 } }));
const { messageText, needlesOf, passageOf, showSource, closePeek, usePeek } = await import("./ask-peek");
const { useAsk, openSource } = await import("./ask");
const { getApp } = await import("~/state/app");

const q = (terms: string[], anyOf?: string[][]) => ({ terms, anyOf });

describe("a cited message shown in Ask: its passage, from the turn's own searches (plan 161, pass 3)", () => {
  it("the words the searches looked for, folded, once each", () => {
    expect(needlesOf([q(["Pago"], [["payment", "pago"]]), q([], [["factura"]])]).map((n) => n.words)).toEqual([["pago"], ["payment"], ["factura"]]);
    expect(needlesOf([q([])])).toEqual([]);
  });

  it("the passage is the first sentence holding one of them; none when no sentence does", () => {
    const text = "Hola Luis. Hubo un problema con el pago de la renta, ¿lo puedes revisar? Gracias.";
    expect(passageOf(text, needlesOf([q([], [["payment", "pago"]])]))).toBe("Hubo un problema con el pago de la renta, ¿lo puedes revisar?");
    expect(passageOf(text, needlesOf([q(["concierto"])]))).toBeNull();
    expect(passageOf(text, [])).toBeNull();
  });

  it("the text part first, else the HTML's words (scripts and styles left out, nothing fetched), else the snippet", () => {
    expect(messageText({ bodyText: " Plain words ", bodyHtml: "<p>html</p>", snippet: "s" })).toBe("Plain words");
    const html = '<html><head><title>T</title><style>p{color:red}</style></head><body><p>First line</p><script>evil()</script><div>Second<br>third</div><img src="https://tracker.test/x.png"></body></html>';
    expect(messageText({ bodyText: null, bodyHtml: html, snippet: "s" })).toBe("First line\nSecond\nthird");
    expect(messageText({ bodyText: "", bodyHtml: null, snippet: "the snippet" })).toBe("the snippet");
  });
});

const source = { messageId: 41, threadId: 9, accountId: 1, fromName: "Ana", fromEmail: "ana@example.com", subject: "El pago", date: 0 };
const message = { id: 41, bodyText: "Hola. Hubo un problema con el pago. Saludos.", bodyHtml: null, snippet: "" };
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("a source shown in Ask stays its conversation's, and Open message asks again if it moved (Codex review, pass 3)", () => {
  it("#2: a source still loading when another conversation begins never shows in it", async () => {
    useAsk.setState({ conversationId: 5, turns: [], sources: {}, armedSource: null });
    const sources = deferred<unknown>();
    rpc.call.mockImplementation(async (method: string) => (method === "ai.askSources" ? sources.promise : { messages: [message] }));
    const shown = showSource(source, 1, [{ terms: ["pago"] }]);
    // New question
    useAsk.setState({ conversationId: null });
    sources.resolve({ 41: { state: "ok", threadId: 9 } });
    await shown;
    expect(usePeek.getState().peek).toBeNull();
    // the same conversation shows it, with its passage
    useAsk.setState({ conversationId: 5 });
    rpc.call.mockImplementation(async (method: string) => (method === "ai.askSources" ? { 41: { state: "ok", threadId: 9 } } : { messages: [message] }));
    await showSource(source, 1, [{ terms: ["pago"] }]);
    expect(usePeek.getState().peek).toMatchObject({ state: "ready", passage: "Hubo un problema con el pago.", approved: "ok" });
    // and another conversation takes it away
    useAsk.setState({ conversationId: 6 });
    expect(usePeek.getState().peek).toBeNull();
    closePeek();
  });

  it("#3: shown while in the Inbox, then moved to Trash elsewhere: Open message asks for the second press first", async () => {
    useAsk.setState({ conversationId: 5, sources: {}, armedSource: null, returnTo: null });
    rpc.call.mockImplementation(async (method: string) => (method === "ai.askSources" ? { 41: { state: "trash", threadId: 9 } } : {}));
    await openSource(source, "ok");
    expect(useAsk.getState().armedSource).toBe(41);
    expect(useAsk.getState().returnTo).toBeNull();
    // shown while in Trash already (its second press given then): it opens
    useAsk.setState({ armedSource: null, dialog: undefined } as never);
    await openSource(source, "trash");
    expect(useAsk.getState().returnTo).toMatchObject({ threadId: 9, messageId: 41 });
    expect(getApp().dialog).toBeNull();
  });
});

