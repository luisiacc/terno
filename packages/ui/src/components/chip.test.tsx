// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chip } from "./chip";

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

describe("Chip (plan 125)", () => {
  it("is a plain label: no button without onRemove", async () => {
    const host = await render(<Chip dot={<i data-testid="dot" />}>Work</Chip>);
    const chip = host.querySelector("[data-slot=chip]")!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("Work");
    expect(chip.firstElementChild!.getAttribute("data-testid")).toBe("dot");
    expect(host.querySelector("button")).toBeNull();
  });

  it("its remove button is named after the chip and runs onRemove", async () => {
    const onRemove = vi.fn();
    const host = await render(
      <Chip onRemove={onRemove} removeLabel="Remove Work" removeProps={{ "data-testid": "x" }}>
        Work
      </Chip>
    );
    const button = host.querySelector<HTMLButtonElement>("[data-testid=x]")!;
    expect(button.getAttribute("aria-label")).toBe("Remove Work");
    expect(button.dataset.slot).toBe("close-button");
    await act(async () => button.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
