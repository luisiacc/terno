// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "./number-field";

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

/** types into the field as the user would (React's onChange listens to input events) */
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("NumberField (plan 125)", () => {
  it("is a text field named by its label, with − and + named for what they do", async () => {
    const host = await render(
      <>
        <label htmlFor="days">Sync window</label>
        <NumberField id="days" defaultValue={30} aria-describedby="hint" data-testid="days" />
      </>,
    );
    const input = host.querySelector<HTMLInputElement>("[data-testid=days]")!;
    expect(input.id).toBe("days");
    expect(input.type).toBe("text");
    expect(input.getAttribute("aria-describedby")).toBe("hint");
    expect(input.value).toBe("30");
    expect([...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Decrease", "Increase"]);
  });

  it("commits what was typed on blur, not while typing", async () => {
    const onValueCommitted = vi.fn();
    const host = await render(<NumberField aria-label="Days" defaultValue={30} onValueCommitted={onValueCommitted} />);
    const input = host.querySelector("input")!;
    await type(input, "45");
    expect(onValueCommitted).not.toHaveBeenCalled();
    await act(async () => input.blur());
    expect(onValueCommitted).toHaveBeenCalledWith(45, expect.anything());
  });

  it("keeps a typed value out of range with allowOutOfRange (the caller says why); without it, clamps on blur", async () => {
    const kept = vi.fn();
    let host = await render(<NumberField aria-label="Days" min={7} max={3650} allowOutOfRange defaultValue={30} onValueCommitted={kept} />);
    let input = host.querySelector("input")!;
    await type(input, "3");
    await act(async () => input.blur());
    expect(kept).toHaveBeenCalledWith(3, expect.anything());
    expect(input.value).toBe("3");
    cleanup?.();

    const clamped = vi.fn();
    host = await render(<NumberField aria-label="Port" min={1} max={65535} format={{ useGrouping: false }} defaultValue={993} onValueCommitted={clamped} />);
    input = host.querySelector("input")!;
    await type(input, "70000");
    await act(async () => input.blur());
    expect(clamped).toHaveBeenCalledWith(65535, expect.anything());
    expect(input.value).toBe("65535");
  });

  it("steps with the arrow keys within its limits; the steppers can be left out", async () => {
    const onValueChange = vi.fn();
    const host = await render(<NumberField aria-label="Days" min={0} max={2} defaultValue={1} steppers={false} onValueChange={onValueChange} />);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    const input = host.querySelector("input")!;
    await act(async () => input.focus());
    await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(onValueChange.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(input.value).toBe("2");
  });
});
