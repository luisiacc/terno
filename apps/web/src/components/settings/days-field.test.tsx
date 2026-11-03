// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaysField } from "./general-tab";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn() } }));
// general-tab's imports read the media queries as they load
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

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
  return { host, rerender: (n: React.ReactNode) => act(async () => root.render(n)) };
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = (input: HTMLInputElement) => act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

const a11y = { id: "days", "aria-describedby": "days-hint" };

describe("DaysField on the shared NumberField (plan 125, revision 2)", () => {
  it("Enter saves a valid number and the field keeps focus", async () => {
    const onSave = vi.fn(async () => {});
    const { host } = await render(<DaysField a11y={a11y} testId="sync-window" value={180} onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    await type(input, "45");
    await enter(input);
    expect(onSave).toHaveBeenCalledWith(45);
    expect(document.activeElement).toBe(input);
  });

  it("text that isn't a number, left with Tab or Enter, stays with the reason (Codex code review #4)", async () => {
    const onSave = vi.fn(async () => {});
    const { host } = await render(<DaysField a11y={a11y} testId="sync-window" value={180} onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    await type(input, ".");
    await act(async () => input.blur());
    expect(input.value).toBe(".");
    expect(host.querySelector("[data-testid=sync-window-error]")?.textContent).toMatch(/from 7 to 3,650/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await type(input, "45");
    expect(host.querySelector("[data-testid=sync-window-error]")).toBeNull();
    await type(input, "-");
    await enter(input);
    expect(host.querySelector("[data-testid=sync-window-error]")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Enter reads the number as leaving the field does, by the locale's rules (Codex code review #5)", async () => {
    // forty-five in Eastern Arabic digits: Base UI's parser reads them (as it reads "45,0" in es-ES), Number() can't
    const onSave = vi.fn(async () => {});
    const { host } = await render(<DaysField a11y={a11y} testId="sync-window" value={180} onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    await type(input, "٤٥");
    await enter(input);
    expect(host.querySelector("[data-testid=sync-window-error]")).toBeNull();
    expect(onSave).toHaveBeenCalledWith(45);
    expect(document.activeElement).toBe(input);
  });

  it("a typed value out of range stays as typed, with the reason announced; typing again clears it", async () => {
    const onSave = vi.fn(async () => {});
    const { host } = await render(<DaysField a11y={a11y} testId="sync-window" value={180} onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    await type(input, "3");
    await enter(input);
    const error = host.querySelector("[data-testid=sync-window-error]")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toMatch(/from 7 to 3,650/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("days-hint days-days-error");
    // leaving the field doesn't clamp it either
    await act(async () => input.blur());
    expect(input.value).toBe("3");
    expect(onSave).not.toHaveBeenCalled();
    await type(input, "30");
    expect(host.querySelector("[data-testid=sync-window-error]")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("an override may be emptied (saved as none); the general window doesn't allow it", async () => {
    const onSave = vi.fn(async () => {});
    const { host } = await render(<DaysField a11y={a11y} testId="account-window" value={30} placeholder="180" allowEmpty onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    expect(input.placeholder).toBe("180");
    await type(input, "");
    await enter(input);
    expect(onSave).toHaveBeenCalledWith(null);
    cleanup?.();

    const general = vi.fn(async () => {});
    const again = await render(<DaysField a11y={a11y} testId="sync-window" value={180} onSave={general} />);
    const field = again.host.querySelector<HTMLInputElement>("#days")!;
    await type(field, "");
    await enter(field);
    expect(general).not.toHaveBeenCalled();
    expect(again.host.querySelector("[data-testid=sync-window-error]")).not.toBeNull();
  });

  it("a stored value that changes shows in place, unless an edit of its own was typed since", async () => {
    const onSave = vi.fn(async () => {});
    const { host, rerender } = await render(<DaysField a11y={a11y} value={180} onSave={onSave} />);
    const input = host.querySelector<HTMLInputElement>("#days")!;
    await rerender(<DaysField a11y={a11y} value={90} onSave={onSave} />);
    expect(input.value).toBe("90");
    await type(input, "60");
    await rerender(<DaysField a11y={a11y} value={120} onSave={onSave} />);
    expect(input.value).toBe("60");
  });
});
