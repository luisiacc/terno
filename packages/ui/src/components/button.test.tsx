// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Send } from "../icons";
import { Button } from "./button";
import { CloseButton } from "./close-button";

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

describe("Button's loading (plan 125)", () => {
  it("is busy and unusable, but keeps focus", async () => {
    const onClick = vi.fn();
    const host = await render(<Button loading onClick={onClick}>Save</Button>);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // focusable (a busy button the user just pressed keeps focus), but it does nothing
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("puts the spinner in place of the leading icon, the label untouched", async () => {
    const host = await render(<Button loading><Send /> Send</Button>);
    const button = host.querySelector("button")!;
    expect(button.querySelector("svg.icon")).toBeNull();
    const spinner = button.querySelector("[data-slot=spinner]")!;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("role")).toBeNull();
    expect(button.firstElementChild).toBe(spinner);
    expect(button.textContent).toBe(" Send");
  });

  it("with no leading icon, keeps the label (transparent: holding the width and the name) and centres the spinner over it", async () => {
    const host = await render(<Button loading>Remove</Button>);
    const button = host.querySelector("button")!;
    const label = [...button.children].find((el) => el.textContent === "Remove")!;
    expect(label.className).toContain("opacity-0");
    expect(label.className).not.toContain("invisible");
    expect(button.querySelector("[data-slot=spinner]")!.parentElement!.className).toContain("absolute inset-0");
  });

  it("not loading, renders its children as given", async () => {
    const host = await render(<Button><Send /> Send</Button>);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector("svg.icon")).not.toBeNull();
    expect(button.querySelector("[data-slot=spinner]")).toBeNull();
  });
});

describe("CloseButton (plan 125)", () => {
  it('is named "Close" by default, or by its label', async () => {
    const host = await render(
      <>
        <CloseButton />
        <CloseButton label="Dismiss the tip" size="2xs" />
      </>,
    );
    const [plain, named] = [...host.querySelectorAll("button")];
    expect(plain!.getAttribute("aria-label")).toBe("Close");
    expect(named!.getAttribute("aria-label")).toBe("Dismiss the tip");
    // the glyph is decorative: the label is the name
    expect(named!.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});
