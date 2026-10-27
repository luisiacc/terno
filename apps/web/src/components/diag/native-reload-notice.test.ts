// @vitest-environment jsdom
import { act, createElement, Fragment, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
vi.mock("~/rpc/connection", () => ({ client: {} }));
vi.mock("~/state/diag", async () => {
  const { create } = await import("zustand");
  return { useDiag: create<{ view: { engine: "running" | "stopped"; reporting: { dsn: boolean } } }>(() => ({ view: { engine: "stopped", reporting: { dsn: false } } })), restartEngine: vi.fn(), exportDiagnostics: vi.fn(), refreshDiag: vi.fn() };
});
const { EngineStopped } = await import("./engine-stopped");
const { NativeReloadNotice } = await import("./native-reload-notice");
const { registerNativeReloadModal, useNativeReload } = await import("~/lib/native-reload");
const { useDraftRecovery } = await import("~/lib/draft-recovery-ui");
const { useDiag, restartEngine } = await import("~/state/diag");
const { copyDraft, createDraft, draftsSaved, editDraft, flushDraft, forgetDraft, markDraftMissing, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
const { SettingsDialog } = await import("../settings-dialog");
const { useApp } = await import("~/state/app");
const { DEFAULT_SETTINGS } = await import("../../../../../packages/backend/src/settings");
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let mounted: Root | undefined;
afterEach(async () => {
  await act(async () => mounted?.unmount()); mounted = undefined;
  useNativeReload.setState({ anyway: null }); useDraftRecovery.setState({ open: false, key: null, reason: "error" });
  useDiag.setState({ view: { ...useDiag.getState().view!, engine: "stopped" } });
  useApp.setState({ settings: null, dialog: null });
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  document.body.replaceChildren(); vi.clearAllMocks();
});

it("a pre-existing Settings modal relinquishes its focus scope while the fatal dialog owns the native actions", async () => {
  useApp.setState({ dialog: "settings", settingsTab: "general", settings: {
    ...DEFAULT_SETTINGS, gmailClientSecretSet: false, gmailClientSecretUnreadable: false,
    ai: { provider: "none", model: "", baseURL: null, preset: null, hasKey: false, keyUnreadable: false, keyHint: null, keyOrigin: null, keyConfirmed: true, local: true, capabilities: null, profiles: {} },
  } });
  useDiag.setState({ view: { ...useDiag.getState().view!, engine: "running" } });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root); mounted = createRoot(root);
  await act(async () => mounted!.render(createElement(Fragment, null, createElement(SettingsDialog), createElement(EngineStopped), createElement(NativeReloadNotice))));
  expect(document.querySelector('[data-testid="settings-dialog"][data-open]')).not.toBeNull();
  await act(async () => { useNativeReload.setState({ anyway: vi.fn() }); useDiag.setState({ view: { ...useDiag.getState().view!, engine: "stopped" } }); });
  expect(document.querySelector('[data-testid="settings-dialog"][data-open]')).toBeNull();
  expect(useApp.getState().dialog).toBe("settings");
  const dialog = document.querySelector('[data-testid="engine-stopped"]')!;
  expect(dialog.contains(document.querySelector('[data-testid="native-reload-review"]'))).toBe(true);
  expect(dialog.closest('[aria-hidden="true"]')).toBeNull();
});

it("the current modal owns cleanup; relocating a focused native action preserves only its own focus", async () => {
  const root = document.createElement("div"), a = document.createElement("div"), b = document.createElement("div");
  root.id = "root"; root.inert = false; document.body.append(root, a, b); mounted = createRoot(root);
  const anyway = vi.fn(); useNativeReload.setState({ anyway });
  await act(async () => mounted!.render(createElement(NativeReloadNotice)));
  let closeA!: () => void, closeB!: () => void;
  try {
    await act(async () => { closeA = registerNativeReloadModal(a, root); });
    await act(async () => { closeB = registerNativeReloadModal(b, root); closeA(); closeA(); });
    expect(b.contains(document.querySelector('[data-testid="native-reload-notice"]'))).toBe(true); expect(root.inert).toBe(true);
    const review = document.querySelector<HTMLButtonElement>('[data-testid="native-reload-review"]')!; review.focus();
    await act(async () => closeB());
    expect(root.inert).toBe(false); expect(root.contains(document.querySelector('[data-testid="native-reload-notice"]'))).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-testid="native-reload-review"]'));
    expect(useNativeReload.getState().anyway).toBe(anyway); expect(anyway).not.toHaveBeenCalled();
  } finally { await act(async () => { closeA?.(); closeB?.(); }); }
});

it("StrictMode and a stopped-to-running transition restore prior inert ownership without dismissing the warning", async () => {
  const root = document.createElement("div"); root.id = "root"; root.inert = true; document.body.append(root); mounted = createRoot(root);
  const anyway = vi.fn(); useNativeReload.setState({ anyway });
  await act(async () => mounted!.render(createElement(StrictMode, null, createElement(EngineStopped), createElement(NativeReloadNotice))));
  expect(root.inert).toBe(true);
  await act(async () => useDiag.setState({ view: { ...useDiag.getState().view!, engine: "running" } }));
  expect(root.inert).toBe(true); expect(useNativeReload.getState().modalHost).toBeNull();
  expect(root.contains(document.querySelector('[data-testid="native-reload-notice"]'))).toBe(true); expect(useNativeReload.getState().anyway).toBe(anyway);
});

it("closing a relocated warning restores its invoking control only while the close action owns focus", async () => {
  const root = document.createElement("div"), trigger = document.createElement("button");
  root.id = "root"; trigger.textContent = "Invoking control"; document.body.append(trigger, root); mounted = createRoot(root);
  trigger.focus(); useNativeReload.setState({ anyway: vi.fn() });
  await act(async () => mounted!.render(createElement(NativeReloadNotice)));
  const close = document.querySelector<HTMLButtonElement>('[data-testid="native-reload-close"]')!;
  close.focus(); await act(async () => close.click());
  expect(document.activeElement).toBe(trigger);
  await act(async () => useNativeReload.setState({ anyway: vi.fn() }));
  const editor = document.createElement("textarea"); document.body.append(editor); editor.focus();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="native-reload-close"]')!.click());
  expect(document.activeElement).toBe(editor);
});
afterAll(() => vi.unstubAllGlobals());

it.each(["missing", "unknown"] as const)("stopped-engine native %s actions belong to the modal, and Review relinquishes it without restarting", async (state) => {
  setDraftTransport(async (_method, p) => ({ ...(p as object), id: 101, generation: "synthetic", revision: 1 }));
  const key = createDraft({ ...newFields(1), toText: '"Pérez, Ana" <ana@example.test>, bob@', quotedText: "> exact quote" });
  editDraft(key, { bodyText: "exact retained work", bodyHtml: "<div><b>exact retained work</b></div>" }); await flushDraft(key); markDraftMissing(key);
  if (state === "unknown") { setDraftTransport(async () => { throw { code: "TIMEOUT" }; }); await copyDraft(key); }
  const root = document.createElement("div"); root.id = "root"; document.body.append(root); mounted = createRoot(root);
  const anyway = vi.fn(); useNativeReload.setState({ anyway });
  await act(async () => mounted!.render(createElement(Fragment, null, createElement(EngineStopped), createElement(NativeReloadNotice))));
  const dialog = document.querySelector('[data-testid="engine-stopped"]')!, notice = document.querySelector('[data-testid="native-reload-notice"]')!;
  expect(root.inert).toBe(true); expect(dialog.contains(notice)).toBe(true); expect(root.contains(notice)).toBe(false);
  expect(document.querySelectorAll('[data-testid="native-reload-notice"]')).toHaveLength(1);
  expect(document.activeElement).toBe(dialog.querySelector('[data-testid="engine-retry"]'));
  await act(async () => (notice.querySelector('[data-testid="native-reload-review"]') as HTMLButtonElement).click());
  expect(useDraftRecovery.getState()).toMatchObject({ open: true, key, reason: "reload" });
  expect(document.querySelector('[data-testid="engine-stopped"]')).toBeNull(); expect(root.inert).toBe(false);
  expect(useDiag.getState().view?.engine).toBe("stopped"); expect(restartEngine).not.toHaveBeenCalled(); expect(anyway).not.toHaveBeenCalled();
  expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "exact retained work", bodyHtml: "<div><b>exact retained work</b></div>", toText: '"Pérez, Ana" <ana@example.test>, bob@', quotedText: "> exact quote", recovery: { state } });
  expect(await draftsSaved()).toBe(false);
  await act(async () => useDraftRecovery.setState({ open: false }));
  expect(document.querySelector('[data-testid="engine-stopped"]')).not.toBeNull(); expect(root.inert).toBe(true);
});
