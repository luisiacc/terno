/**
 * Sending a draft: one send per draft at a time, whatever remounts or
 * double-submits in between; nothing can be edited under a send in flight.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ calls: [] as { method: string; resolve(v: unknown): void; reject(e: unknown): void }[] }));
vi.mock("~/rpc/connection", () => ({
  client: { call: (method: string) => new Promise((resolve, reject) => rpc.calls.push({ method, resolve, reject })) },
}));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));

const { sendDraft } = await import("./compose");
const { createDraft, discardDraft, editDraft, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { useSnack } = await import("./snack");

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rpc.calls.length = 0;
  useDrafts.setState({ drafts: {} });
});

describe("sending a draft", () => {
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
    rpc.calls[0]!.resolve({ opId: "o", threadId: 1 });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
  });

  it("a failed send releases the draft for editing and another try", async () => {
    const key = createDraft({ ...newFields(1), toText: "ana@example.com", bodyText: "Hola" });
    const p = sendDraft(key);
    await tick();
    rpc.calls[0]!.reject(new Error("sin conexión"));
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
    expect(useSnack.getState().current?.message).toBe("Check the recipients");

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
