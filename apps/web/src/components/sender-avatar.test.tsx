// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// what the icon layer asks for, not the store's machinery (sender-icons.test.ts)
const asked = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/sender-icons", () => ({ useSenderIcon: (email: string) => { asked.push(email); return null; }, iconFailed: () => {} }));
const { SenderAvatar } = await import("./sender-avatar");

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; asked.length = 0; });

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

describe("SenderAvatar's icon (plans 22, 158, 258)", () => {
  it("a company's avatar has the icon layer, which looks its address up", async () => {
    const host = await render(<SenderAvatar name="Netflix" email="info@netflix.com" icon />);
    expect(host.querySelector("[data-testid=sender-avatar] > span")).not.toBeNull();
    expect(asked).toEqual(["info@netflix.com"]);
  });

  it("a person's avatar is their initials and looks nothing up (plan 258: no photos)", async () => {
    const host = await render(<SenderAvatar name="Ana Ruiz" email="ana@acme.studio" icon person />);
    expect(host.querySelector("[data-testid=sender-avatar]")?.textContent).toBe("AR");
    expect(host.querySelector("[data-testid=sender-avatar] > span")).toBeNull();
    expect(asked).toEqual([]);
  });
});
