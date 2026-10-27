// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadLocale, t } from "@terno/i18n";
import { UncertainWriteError } from "@terno/idb/uncertainty";
import { expect, it, vi } from "vitest";
import { WebGate } from "./gate";
import { setWeb } from "./lifecycle";
import { uncertainStoreFailure } from "./worker/storage-error";

vi.mock("./connect", () => ({ requestTakeover: vi.fn(), takeBack: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn() } }));
vi.mock("./reload", () => ({ whenDraftsSaved: vi.fn().mockResolvedValue(false) }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it.each(["en", "es"] as const)("keeps uncertain storage closed with explicit localized guidance (%s)", async (locale) => {
  await loadLocale(locale);
  const { whenDraftsSaved } = await import("./reload");
  vi.mocked(whenDraftsSaved).mockClear();
  const failure = uncertainStoreFailure(new UncertainWriteError());
  expect(failure).toMatchObject({ type: "fatal", code: "UNCERTAIN_STORE", message: { key: "web.gate.uncertain.body" } });
  const host = document.createElement("main"); host.id = "root"; document.body.append(host);
  const root = createRoot(host);
  setWeb({ phase: "fatal", code: failure!.code, message: "private underlying exception must not be displayed" });
  try {
    await act(async () => root.render(<StrictMode><WebGate /></StrictMode>));
    const dialog = document.querySelector<HTMLElement>('[data-testid="web-fatal"]')!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain(t("web.gate.uncertain.title"));
    expect(dialog.textContent).toContain(t("web.gate.uncertain.body"));
    expect(dialog.textContent).not.toContain("private underlying exception");
    expect(host.inert).toBe(true);
    const reload = dialog.querySelector<HTMLButtonElement>('[data-testid="web-reload"]')!;
    expect(reload.textContent).toBe(t("web.gate.reload"));
    expect(document.activeElement).toBe(reload);
    expect(whenDraftsSaved).not.toHaveBeenCalled();
    await act(async () => reload.click());
    expect(whenDraftsSaved).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    expect(host.inert).toBe(false);
    host.remove(); setWeb({ phase: "ready", code: null, message: null });
    await loadLocale("en");
  }
});

it("does not reclassify unrelated storage errors or expose the original cause", () => {
  expect(uncertainStoreFailure(new Error("unrelated"))).toBeNull();
  const failure = uncertainStoreFailure(new UncertainWriteError("unreadable", new Error("private cause")));
  expect(failure?.message).toMatchObject({ key: "web.gate.uncertain.body" });
  expect(JSON.stringify(failure)).not.toContain("private cause");
});
