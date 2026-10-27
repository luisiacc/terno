// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ call: vi.fn().mockResolvedValue([]) }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call, on: () => () => {} } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const { DraftFieldsForm } = await import("./inline-draft");
const drafts = await import("~/lib/drafts");
const { newFields, convertFields } = await import("~/lib/compose-fields");
const app = await import("~/state/app");
const { sendDraft } = await import("~/lib/compose");
const address = "auto@example.test";
const keydown = (element: Element, key: string, options: KeyboardEventInit = {}) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

it("Undo restores chip text while the edited address stays authored for Forward", async () => {
  const key = drafts.createDraft({ ...newFields(1), toText: address, auto: { to: [address], cc: [], bcc: [] } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Form() { const d = drafts.useDrafts((s) => s.drafts[key]!); return <DraftFieldsForm d={d} accounts={[]} showSubject={false} />; }
  try {
    await act(async () => root.render(<Form />));
    const input = host.querySelector<HTMLInputElement>('[data-testid="compose-to"]')!;
    await act(async () => { input.focus(); input.setSelectionRange(0, 0); keydown(input, "Backspace"); });
    const chip = host.querySelector<HTMLElement>('[data-chip-key]')!; expect(document.activeElement).toBe(chip);
    await act(async () => { keydown(chip, "F2"); });
    await act(async () => { keydown(input, "Enter"); });
    expect(drafts.useDrafts.getState().drafts[key]!.auto.to).toEqual([]);
    await act(async () => { keydown(input, "z", { metaKey: true }); });
    await act(async () => { keydown(input, "z", { metaKey: true }); });
    expect(drafts.useDrafts.getState().drafts[key]!.toText).toContain(address);
    const restored = drafts.useDrafts.getState().drafts[key]!;
    expect(restored.auto.to).toEqual([]);
    const detail = { thread: { id: 7, accountId: 1, subject: "Subject" }, messages: [{ id: 3, isSent: false, from: { email: address, name: "Sender" }, to: [], cc: [], subject: "Subject", date: 0, bodyText: "", attachments: [] }] } as unknown as import("@terno/core").ThreadDetail;
    const account = { id: 1, email: "me@example.test" } as import("@terno/core").Account;
    expect(convertFields(restored, "forward", detail, account).toText).toContain(address);
  } finally { await act(async () => root.unmount()); drafts.forgetDraft(key); host.remove(); }
});

it("does not locally remove a recipient while Send holds the draft", async () => {
  const previous = app.getApp();
  const key = drafts.createDraft({ ...newFields(1), toText: address });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const gate = deferred<{ threadId: number }>(), entered = deferred<void>();
  let sends = 0;
  rpc.call.mockImplementation(async (method) => { if (method === "compose.send") { if (++sends === 1) { entered.resolve(); return gate.promise; } throw new Error("offline again"); } return []; });
  drafts.setDraftTransport(async (_method, params) => ({ ...params as object, id: 99, generation: "stable", revision: 1, updatedAt: 0 }));
  function Form() { const d = drafts.useDrafts((s) => s.drafts[key]!); return <DraftFieldsForm d={d} accounts={[]} showSubject={false} />; }
  let pending: Promise<boolean> | undefined;
  try {
    app.setApp({ accounts: [{ id: 1, kind: "imap", email: "me@example.test", displayName: "Me", signature: "", color: "blue", syncState: {} }] as never });
    await act(async () => root.render(<Form />));
    await act(async () => { pending = sendDraft(key); });
    await entered.promise; expect(drafts.useDrafts.getState().drafts[key]!.sending).toBe(true);
    const input = host.querySelector<HTMLInputElement>('[data-testid="compose-to"]')!;
    expect(input.readOnly).toBe(true);
    await act(async () => { input.focus(); input.setSelectionRange(0, 0); keydown(input, "Backspace"); });
    const chip = host.querySelector<HTMLElement>('[data-chip-key]')!;
    await act(async () => { keydown(chip, "Backspace"); keydown(chip, "z", { metaKey: true }); });
    await act(async () => { input.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })); });
    const visibleDuringSend = host.querySelector('[data-chip-key]') !== null;
    gate.reject(new Error("offline")); await act(async () => { await pending; });
    expect(drafts.useDrafts.getState().drafts[key]!.toText).toContain(address);
    expect(visibleDuringSend).toBe(true);
    expect(host.querySelector('[data-chip-key]')).not.toBeNull();
    await act(async () => { expect(await sendDraft(key)).toBe(false); });
    const requests = rpc.call.mock.calls.filter(([method]) => method === "compose.send");
    expect(requests).toHaveLength(2);
    expect(requests[0]![1].to).toEqual(requests[1]![1].to);
    expect(requests[1]![1].to).toEqual(expect.arrayContaining([expect.objectContaining({ email: address })]));
  } finally { gate.reject(new Error("cleanup")); await act(async () => { await pending?.catch(() => {}); }); await act(async () => root.unmount()); drafts.forgetDraft(key); drafts.setDraftTransport(async () => null); app.useApp.setState(previous, true); host.remove(); rpc.call.mockReset(); }
});

it("ordinarily removes an automatic chip and Undo restores its text and ownership", async () => {
  const key = drafts.createDraft({ ...newFields(1), toText: address, auto: { to: [address], cc: [], bcc: [] } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Form() { const d = drafts.useDrafts((s) => s.drafts[key]!); return <DraftFieldsForm d={d} accounts={[]} showSubject={false} />; }
  try {
    await act(async () => root.render(<Form />));
    const input = host.querySelector<HTMLInputElement>('[data-testid="compose-to"]')!;
    await act(async () => { input.focus(); input.setSelectionRange(0, 0); keydown(input, "Backspace"); });
    await act(async () => keydown(host.querySelector('[data-chip-key]')!, "Backspace"));
    expect(drafts.useDrafts.getState().drafts[key]!.toText).toBe("");
    await act(async () => keydown(input, "z", { metaKey: true }));
    expect(drafts.useDrafts.getState().drafts[key]!.toText).toContain(address);
    expect(drafts.useDrafts.getState().drafts[key]!.auto.to).toEqual([address]);
  } finally { await act(async () => root.unmount()); drafts.forgetDraft(key); host.remove(); }
});

it.each(["send begins", "field restored", "field roundtrip"] as const)("recipient publication honors synchronous %s", async (scenario) => {
  const key = drafts.createDraft({ ...newFields(1), toText: address });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); let triggered = false;
  function Form() { const d = drafts.useDrafts((s) => s.drafts[key]!); return <DraftFieldsForm d={d} accounts={[]} showSubject={false} />; }
  const off = drafts.useDrafts.subscribe((state, previous) => {
    if (!triggered && state.drafts[key]?.toText !== previous.drafts[key]?.toText) {
      triggered = true;
      if (scenario === "send begins") drafts.markSending(key, true);
      else if (scenario === "field restored") drafts.editDraft(key, { toText: address });
      else { const expected = state.drafts[key]!.toText; drafts.editDraft(key, { toText: address }); drafts.editDraft(key, { toText: expected }); }
    }
  });
  try {
    await act(async () => root.render(<Form />));
    const input = host.querySelector<HTMLInputElement>('[data-testid="compose-to"]')!;
    await act(async () => {
      input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "later@");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(triggered).toBe(true);
    if (scenario === "send begins") {
      expect(drafts.useDrafts.getState().drafts[key]!.toText).toContain("later@");
      expect(input.value).toBe("later@"); expect(input.readOnly).toBe(true);
    } else if (scenario === "field restored") {
      expect(drafts.useDrafts.getState().drafts[key]!.toText).toBe(address);
      expect(input.value).toBe("");
    } else {
      expect(drafts.useDrafts.getState().drafts[key]!.toText).toContain("later@");
      expect(input.value).toBe("later@");
    }
  } finally { off(); await act(async () => root.unmount()); drafts.forgetDraft(key); host.remove(); }
});
