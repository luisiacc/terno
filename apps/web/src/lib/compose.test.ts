/**
 * Sending a draft: one send per draft at a time, whatever remounts or
 * double-submits in between; nothing can be edited under a send in flight.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ autoSave: true, calls: [] as { method: string; resolve(v: unknown): void; reject(e: unknown): void }[] }));
vi.mock("~/rpc/connection", () => ({
  client: { call: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => {
    rpc.calls.push({ method, resolve, reject });
    if (method === "drafts.save" && rpc.autoSave) resolve({ ...params, id: params.id ?? 42, generation: params.generation ?? "identity", revision: Number(params.baseRevision ?? 0) + 1 });
  }) },
}));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));

const { bodyParts, sendDraft } = await import("./compose");
const { createDraft, discardDraft, editDraft, markDraftMissing, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { useSnack } = await import("./snack");
const { setApp } = await import("~/state/app");

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setApp({ accounts: [{ id: 1, email: "me@example.test" } as import("@terno/core").Account] });
  rpc.calls.length = 0; rpc.autoSave = true;
  useDrafts.setState({ drafts: {} });
});

describe("sending a draft", () => {
  it("unresolved recovery refuses Send before locking and preserves editable work", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "keep" });
    markDraftMissing(key);
    const sending = sendDraft(key);
    expect(useDrafts.getState().drafts[key]!.sending).toBe(false);
    editDraft(key, { bodyText: "still editable" });
    expect(await sending).toBe(false);
    expect(rpc.calls).toHaveLength(0);
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("still editable");
  });

  it("a pending save returning null stops the Send waiting for it", async () => {
    rpc.autoSave = false;
    vi.useFakeTimers();
    try {
      const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "keep" });
      editDraft(key, {}); await vi.advanceTimersByTimeAsync(800);
      const sending = sendDraft(key);
      rpc.calls.find((c) => c.method === "drafts.save")!.resolve(null);
      expect(await sending).toBe(false);
      expect(rpc.calls.filter((c) => c.method === "compose.send")).toHaveLength(0);
      expect(useDrafts.getState().drafts[key]).toMatchObject({ recovery: { state: "missing" }, sending: false, bodyText: "keep" });
    } finally { vi.useRealTimers(); }
  });

  it.each(["draftMissing", "draftRevision"])("clean externally changed target reports typed %s without submission retry", async (reason) => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "keep" });
    useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, id: 42, generation: "identity", revision: 1, status: "saved" } } }));
    const sending = sendDraft(key); await tick();
    rpc.calls.find((c) => c.method === "compose.send")!.reject({ code: "STALE", details: { reason } });
    expect(await sending).toBe(false);
    expect(useDrafts.getState().drafts[key]!.recovery?.state).toBe(reason === "draftMissing" ? "missing" : undefined);
    expect(useDrafts.getState().drafts[key]!.sending).toBe(false);
    expect(rpc.calls.filter((c) => c.method === "compose.send")).toHaveLength(1);
  });

  it("a second send while the first is in flight gets the same outcome; one compose.send goes out", async () => {
    const key = createDraft({ ...newFields(1), toText: "Ana <ana@example.com>", bodyText: "Hola" });
    const first = sendDraft(key);
    await tick();
    const second = sendDraft(key);
    await tick();
    expect(rpc.calls.filter((c) => c.method === "compose.send")).toHaveLength(1);
    // meanwhile: no edit lands, and the draft can't be discarded
    editDraft(key, { bodyText: "cambiado" });
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("Hola");
    expect(await discardDraft(key)).toBeUndefined();
    rpc.calls.find((c) => c.method === "compose.send")!.resolve({ opId: "o", threadId: 1 });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
  });

  it("a failed send releases the draft for editing and another try", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "Hola" });
    const p = sendDraft(key);
    await tick();
    rpc.calls.find((c) => c.method === "compose.send")!.reject(new Error("sin conexión"));
    expect(await p).toBe(false);
    editDraft(key, { bodyText: "Hola otra vez" });
    expect(useDrafts.getState().drafts[key]!).toMatchObject({ bodyText: "Hola otra vez", sending: false });
  });

  it("a send that fails (validation or the backend) leaves autosave running: what was written still gets saved", async () => {
    vi.useFakeTimers();
    try {
      // nobody to send to: refused, but the text typed just before must still be saved
      const key = createDraft({ ...newFields(1), bodyText: "" });
      editDraft(key, { bodyText: "Texto sin destinatario" });
      expect(await sendDraft(key)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpc.calls.filter((c) => c.method === "drafts.save")).toHaveLength(1);
      rpc.calls.length = 0;
      // the backend refuses: same
      const k2 = createDraft({ ...newFields(1), toText: "ana@example.com" });
      editDraft(k2, { bodyText: "Otro" });
      const p = sendDraft(k2);
      await vi.advanceTimersByTimeAsync(0);
      rpc.calls.find((c) => c.method === "compose.send")!.reject(new Error("sin conexión"));
      expect(await p).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(rpc.calls.filter((c) => c.method === "drafts.save")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what sending says", () => {
  afterEach(() => setLocale("en", en));

  it("refused, failed and sent, in the active language", async () => {
    const refused = createDraft({ ...newFields(1), toText: "ana@" });
    expect(await sendDraft(refused)).toBe(false);
    // it says which entry isn't an address (plan 34), and when nobody is there at all
    expect(useSnack.getState().current?.message).toBe("“ana@” isn’t an email address. Fix or remove it, then send.");
    expect(await sendDraft(createDraft({ ...newFields(1), toText: "" }))).toBe(false);
    expect(useSnack.getState().current?.message).toBe("Add a recipient to send");

    const failing = createDraft({ ...newFields(1), toText: "ana@example.com" });
    const p = sendDraft(failing);
    await tick();
    rpc.calls.find((c) => c.method === "compose.send")!.reject(new Error("offline"));
    await p;
    expect(useSnack.getState().current?.message).toBe("Couldn’t send: offline");

    rpc.calls.length = 0;
    setLocale("es", es);
    const sent = createDraft({ ...newFields(1), toText: "ana@example.com" });
    const q = sendDraft(sent);
    await tick();
    rpc.calls.find((c) => c.method === "compose.send")!.resolve({ opId: "o", threadId: 1 });
    await q;
    expect(useSnack.getState().current?.message).toBe("Enviando…");
  });
});

describe("Codex review 2: the draft is read-only from the moment Send is pressed", () => {
  it("an edit right after Send (while its save settles) is refused, so nothing typed falls between them", () => {
    const key = createDraft({ ...newFields(1), toText: "Ana <ana@example.com>", bodyText: "Hola" });
    void sendDraft(key);
    expect(useDrafts.getState().drafts[key]!.sending).toBe(true);
    editDraft(key, { bodyText: "Hola, otra cosa" });
    expect(useDrafts.getState().drafts[key]!.bodyText).toBe("Hola");
  });
});

describe("the body sent (plan 16)", () => {
  it("a plain draft sends text only; a stored rich body is re-read through the schema, so only schema HTML goes out and the text matches it", async () => {
    const { JSDOM } = await import("jsdom");
    const g = globalThis as { document?: Document };
    const before = g.document;
    g.document = new JSDOM("").window.document;
    try {
      expect(await bodyParts({ bodyText: "hola", bodyHtml: "", canonical: false })).toEqual({ text: "hola", html: null });
      // what the editor serialized this session is trusted as is
      expect(await bodyParts({ bodyText: "t", bodyHtml: "<div><b>t</b></div>", canonical: true })).toEqual({ text: "t", html: "<div><b>t</b></div>" });
      // an imported or agent-era stored body: scripts, handlers, remote images and unsafe links don't survive; the text follows the HTML
      const stored = '<div>Hola <b>Ana</b><img src="https://t.example/p.gif" onerror="x()"><script>x()</script> <a href="javascript:x()">mal</a> <a href="https://ok.example">bien</a></div><ul><li>uno</li></ul>';
      const parts = await bodyParts({ bodyText: "algo distinto", bodyHtml: stored, canonical: false });
      expect(parts.html).toBe('<div>Hola <b>Ana</b> mal <a href="https://ok.example">bien</a></div><ul style="margin:0 0 0 24px;padding:0"><li>uno</li></ul>');
      expect(parts.text).toBe("Hola Ana mal bien (https://ok.example)\n• uno");
    } finally {
      g.document = before;
    }
  });
});
