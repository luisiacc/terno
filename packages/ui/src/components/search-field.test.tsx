// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField, type SearchFieldProps } from "./search-field";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

function Field({ initial = "", ...props }: Partial<SearchFieldProps> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <SearchField aria-label="Search" value={value} onValueChange={setValue} hint={<kbd>/</kbd>} {...props} />;
}

const escape = (el: Element) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

describe("SearchField (plan 125)", () => {
  it("shows the hint while empty and a named clear once there is text; clearing keeps focus in the field", async () => {
    const host = await render(<Field initial="ana" />);
    const input = host.querySelector("input")!;
    const clear = host.querySelector<HTMLButtonElement>("[data-slot=close-button]")!;
    expect(clear.getAttribute("aria-label")).toBe("Clear search");
    expect(clear.tabIndex).toBe(-1);
    expect(host.querySelector("kbd")).toBeNull();
    await act(async () => clear.click());
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(host.querySelector("[data-slot=close-button]")).toBeNull();
    expect(host.querySelector("kbd")).not.toBeNull();
  });

  it("Escape clears the text", async () => {
    const host = await render(<Field initial="ana" />);
    const input = host.querySelector("input")!;
    await act(async () => void escape(input));
    expect(input.value).toBe("");
  });

  it("the caller's keys run first; it can keep Escape for itself", async () => {
    const seen: string[] = [];
    const host = await render(<Field initial="ana" clearOnEscape={false} onKeyDown={(e) => seen.push(e.key)} />);
    const input = host.querySelector("input")!;
    await act(async () => void escape(input));
    expect(seen).toEqual(["Escape"]);
    expect(input.value).toBe("ana");
  });

  it("forwards its ref to the input", async () => {
    const ref: { current: HTMLInputElement | null } = { current: null };
    const host = await render(<Field ref={ref} data-testid="q" />);
    expect(ref.current).toBe(host.querySelector("input"));
    expect(ref.current!.dataset.testid).toBe("q");
  });
});
