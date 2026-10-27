// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue([]) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const { DraftFieldsForm } = await import("./inline-draft");
const { RecipientInput } = await import("./recipient-input");
const { createDraft, forgetDraft, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");

it("keeps chip deletion, undo, re-entry and unfinished text while deriving recipient ownership", async () => {
  const key = createDraft({ ...newFields(1), toText: "auto@example.test", auto: { to: ["auto@example.test"], cc: [], bcc: [] } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Form() { const d = useDrafts((s) => s.drafts[key]!); return <DraftFieldsForm d={d} accounts={[]} showSubject={false} />; }
  const keydown = (element: Element, key: string, options: KeyboardEventInit = {}) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
  try {
    await act(async () => root.render(<Form />));
    const input = host.querySelector<HTMLInputElement>('[data-testid="compose-to"]')!;
    expect(input).not.toBeNull();
    await act(async () => { input.focus(); input.setSelectionRange(0, 0); keydown(input, "Backspace"); });
    const chip = host.querySelector<HTMLElement>('[data-chip-key]')!;
    expect(document.activeElement).toBe(chip);
    await act(async () => { keydown(chip, "Backspace"); });
    expect(useDrafts.getState().drafts[key]!.toText).toBe("");
    expect(useDrafts.getState().drafts[key]!.auto.to).toEqual(["auto@example.test"]);
    await act(async () => { keydown(input, "z", { metaKey: true }); });
    expect(useDrafts.getState().drafts[key]!.toText).toContain("auto@example.test");
    await act(async () => { input.focus(); input.setSelectionRange(0, 0); keydown(input, "Backspace"); });
    await act(async () => { keydown(host.querySelector('[data-chip-key]')!, "Backspace"); });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "auto@example.test"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { keydown(input, "Enter"); });
    expect(useDrafts.getState().drafts[key]!.toText).toContain("auto@example.test");
    expect(useDrafts.getState().drafts[key]!.auto.to).toEqual([]);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "unfinished@"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(useDrafts.getState().drafts[key]!.toText).toContain("unfinished@");
  } finally { await act(async () => root.unmount()); forgetDraft(key); host.remove(); }
});

it("forwards a same-value authored commit once and ignores an empty commit", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), changed = vi.fn();
  try {
    await act(async () => root.render(<RecipientInput id="recipient" testId="recipient" label="To" value="" onChange={changed} accountId={1} others={[]} />));
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "person@example.test");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(changed).toHaveBeenLastCalledWith("person@example.test", ["person@example.test"]);
    const count = changed.mock.calls.length;
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(changed).toHaveBeenCalledTimes(count);
    expect(document.activeElement).toBe(input);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
