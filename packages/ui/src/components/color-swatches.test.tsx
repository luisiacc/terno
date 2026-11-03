// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorSwatch, ColorSwatches } from "./color-swatches";

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

describe("ColorSwatches (plan 125)", () => {
  it("is one radio group of swatches, each named for its colour and filled with it", async () => {
    const onValueChange = vi.fn();
    const host = await render(
      <ColorSwatches aria-label="Color" defaultValue="rose" onValueChange={onValueChange}>
        <ColorSwatch value="rose" label="Rose" color="var(--cat-rose)" data-testid="rose" />
        <ColorSwatch value="violet" label="Violet" color="var(--cat-violet)" data-testid="violet" />
        <ColorSwatch value="none" label="No highlight">
          <span className="stroke" />
        </ColorSwatch>
      </ColorSwatches>,
    );
    expect(host.querySelector("[role=radiogroup]")!.getAttribute("aria-label")).toBe("Color");
    const swatches = [...host.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual(["Rose", "Violet", "No highlight"]);
    expect(swatches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(swatches[1]!.style.backgroundColor).toBe("var(--cat-violet)");
    expect(swatches[2]!.style.backgroundColor).toBe("");
    expect(swatches[2]!.querySelector(".stroke")).not.toBeNull();

    await act(async () => host.querySelector<HTMLElement>("[data-testid=violet]")!.click());
    expect(onValueChange).toHaveBeenCalledWith("violet", expect.anything());
    await act(async () => swatches[1]!.focus());
    await act(async () => swatches[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onValueChange).toHaveBeenLastCalledWith("none", expect.anything());
    expect(document.activeElement).toBe(swatches[2]);
  });
});
