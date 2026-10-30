// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const allocations = vi.hoisted(() => ({ chips: 0 }));
vi.mock("react/jsx-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-runtime")>();
  return { ...runtime, jsx: (...args: Parameters<typeof runtime.jsx>) => {
    if (typeof args[1] === "object" && args[1] !== null && "chip" in args[1]) allocations.chips++;
    return runtime.jsx(...args);
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[1] === "object" && args[1] !== null && "chip" in args[1]) allocations.chips++;
    return runtime.jsxDEV(...args);
  } };
});
vi.mock("~/lib/autocomplete", () => ({ warmAutocomplete() {}, prefetchRecipientInitials() {}, recipientInitials: () => ({}), suggestRecipients: async () => ({ ready: true, items: [] }) }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { RecipientInput } = await import("./recipient-input");

it("typing reuses all chip elements while selection, edits and Undo still update them", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const initial = Array.from({ length: 200 }, (_, i) => `Persona ${i} <persona${i}@example.com>`).join(", ");
  let stored = initial;
  function Field() {
    const [value, setValue] = useState(initial);
    return <RecipientInput id="to" testId="to" label="To" value={value} onChange={(next) => { stored = next; setValue(next); }} accountId={1} others={[]} />;
  }
  const key = (el: Element, value: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(<Field />));
    const input = host.querySelector("input")!;
    await act(async () => input.focus());
    const chips = () => [...host.querySelectorAll<HTMLElement>("[data-chip-key]")];
    expect(chips()).toHaveLength(200);
    expect(allocations.chips).toBeGreaterThanOrEqual(200);
    const before = allocations.chips;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "qzx");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(stored).toBe(`${initial}, qzx`);
    expect(input.value).toBe("qzx");
    expect(document.activeElement).toBe(input);
    expect(allocations.chips, "unchanged chip element allocations").toBe(before);
    await act(async () => { input.setSelectionRange(0, 0); key(input, "ArrowLeft"); });
    expect(chips().at(-1)!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(chips().at(-1));
    await act(async () => key(chips().at(-1)!, "Delete"));
    expect(chips()).toHaveLength(199);
    await act(async () => input.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })));
    expect(chips()).toHaveLength(200);
    expect(stored).toBe(`${initial}, qzx`);
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
    expect(document.activeElement).toBe(input);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
