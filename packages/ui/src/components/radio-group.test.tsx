// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Radio, RadioCard, RadioDot, RadioGroup } from "./radio-group";

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

const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

function Layouts({ onPick }: { onPick: (v: string) => void }) {
  const [value, setValue] = useState("split");
  return (
    <RadioGroup aria-label="Layout" value={value} onValueChange={(v) => (setValue(v as string), onPick(v as string))}>
      <RadioCard value="split">
        Split <RadioDot />
      </RadioCard>
      <RadioCard value="list">
        List <RadioDot />
      </RadioCard>
      <RadioCard value="stack">
        Stack <RadioDot />
      </RadioCard>
    </RadioGroup>
  );
}

describe("RadioGroup (plan 125)", () => {
  it("is a radiogroup of radios, the chosen one checked and the only one in the Tab order", async () => {
    const host = await render(<Layouts onPick={() => {}} />);
    expect(host.querySelector("[role=radiogroup]")!.getAttribute("aria-label")).toBe("Layout");
    const radios = [...host.querySelectorAll("[role=radio]")];
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(radios[1]!.textContent).toBe("List ");
  });

  it("arrow keys move the choice and choose it, wrapping at the ends", async () => {
    const onPick = vi.fn();
    const host = await render(<Layouts onPick={onPick} />);
    const radios = () => [...host.querySelectorAll<HTMLElement>("[role=radio]")];
    await act(async () => radios()[0]!.focus());
    await key(radios()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(radios()[1]);
    expect(onPick).toHaveBeenLastCalledWith("list");
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    await key(radios()[1]!, "ArrowRight");
    expect(onPick).toHaveBeenLastCalledWith("stack");
    await key(radios()[2]!, "ArrowDown");
    expect(document.activeElement).toBe(radios()[0]);
    expect(onPick).toHaveBeenLastCalledWith("split");
    await key(radios()[0]!, "ArrowUp");
    expect(onPick).toHaveBeenLastCalledWith("stack");
  });

  it("a click chooses; a labelled radio is named by its label", async () => {
    const onValueChange = vi.fn();
    const host = await render(
      <RadioGroup aria-label="Size" defaultValue="s" onValueChange={onValueChange}>
        <Radio value="s">Small</Radio>
        <Radio value="l">Large</Radio>
      </RadioGroup>,
    );
    const large = [...host.querySelectorAll<HTMLElement>("[role=radio]")][1]!;
    await act(async () => large.click());
    expect(onValueChange).toHaveBeenCalledWith("l", expect.anything());
    expect(large.getAttribute("aria-checked")).toBe("true");
    expect(large.closest("label")!.textContent).toBe("Large");
  });
});
