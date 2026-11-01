import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

it("ignores a transient about:blank load until the owned mail document is ready", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const errors: unknown[] = [];
  const record = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", record);
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const { HtmlBody } = await import("../../src/components/mail-body");
    await act(async () => root.render(createElement(HtmlBody, { html: "<p>Exact body</p>", messageId: 77, remoteImages: "ask", appearance: "auto" })));
    const frame = host.querySelector("iframe")!;
    expect(frame.contentDocument!.querySelector("[data-terno-flow]")).toBeNull();
    await act(async () => { frame.dispatchEvent(new Event("load")); });
    expect(errors).toEqual([]);
    expect(frame.style.height).toBe("120px");
  } finally {
    await act(async () => root.unmount()); host.remove();
    window.removeEventListener("error", record); vi.unstubAllGlobals();
  }
});
