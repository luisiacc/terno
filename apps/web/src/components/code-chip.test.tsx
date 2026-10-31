// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CodeChip } from "./code-chip";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("the copied check takes the shared icon line (plan 92): svg.icon, its own stroke, no width of its own", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<CodeChip threadId={1} code="123456" />));
  const check = host.querySelector("svg.code-chip-check")!;
  expect(check.classList.contains("icon")).toBe(true);
  expect(check.hasAttribute("stroke-width")).toBe(false);
  const path = check.querySelector("path")!;
  expect(path.getAttribute("stroke")).toBe("currentColor");
  expect(path.hasAttribute("stroke-width")).toBe(false);
  await act(async () => root.unmount());
});
