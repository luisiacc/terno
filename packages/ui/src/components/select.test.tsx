// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

const ITEMS = [
  { value: "system", label: "System (English)" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

describe("Select", () => {
  // Base UI mounted a closed select's items, which its typeahead matches, a timer after the trigger took focus: letters
  // typed before that timer (a fast typist, or a busy page) matched nothing and the choice was lost
  it("typing on the closed control applies the choice from the first key after focus", async () => {
    const onValueChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Select value="system" onValueChange={onValueChange} items={ITEMS}>
          <SelectTrigger aria-label="Language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEMS.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      ),
    );
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const trigger = host.querySelector<HTMLElement>("[role=combobox]")!;
    // each its own task, as a browser delivers them, and no timers run in between
    act(() => trigger.focus());
    for (const key of "Esp") act(() => void trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    // "E" is English, "Es" Español
    expect(onValueChange.mock.calls.map((c) => c[0])).toEqual(["en", "es", "es"]);
  });
});
