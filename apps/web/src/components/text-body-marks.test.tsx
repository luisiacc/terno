// @vitest-environment jsdom
/** A plain-text body's search marks are bounded, as an HTML mail's are: one budget for the whole body (Codex series review). */
import { rowMatchOf } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { TextBody } = await import("./mail-body");

it("a 500,000-character body repeating the words, links among them: a few hundred marks, every character still there", async () => {
  const text = "pago https://x.example/pago ".repeat(18_000);
  expect(text.length).toBeGreaterThan(500_000);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<TextBody text={text} marks={rowMatchOf("pago")!.body} />));
  const marks = host.querySelectorAll("mark[data-reader-match]");
  expect(marks.length).toBeGreaterThan(0);
  expect(marks.length).toBeLessThanOrEqual(300);
  // links keep being links, and the text reads as it was
  expect(host.querySelectorAll("a").length).toBe(18_000);
  expect(host.textContent).toBe(text);
  await act(async () => root.unmount());
});
