/**
 * What the Diagnostics surfaces show and do, the same on both hosts: main
 * (desktop, over the bridge) or this page (diag-local.ts). The view is
 * refetched whenever the host says something changed.
 */
import { breadcrumb, type DiagView, type FieldValueOf, type ReportEvent } from "@terno/core/diag";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { snack } from "~/lib/snack";
import { DESKTOP_DIAG } from "~/lib/diag";
import { localDiag, startLocalDiag } from "~/lib/diag-local";
import { getApp, useApp } from "~/state/app";

export interface DiagPreview {
  /** a record's id, or "sample" */
  target: string;
  event: ReportEvent;
  host: string | null;
}

interface DiagStore {
  view: DiagView | null;
  preview: DiagPreview | null;
}

export const useDiag = create<DiagStore>(() => ({ view: null, preview: null }));

const host = {
  state: () => (DESKTOP_DIAG ? DESKTOP_DIAG.state() : Promise.resolve(localDiag.view())),
  decide: (ids: string[], d: "send" | "dismiss") => (DESKTOP_DIAG ? DESKTOP_DIAG.decide(ids, d) : localDiag.decide(ids, d)),
  preview: (target: string) => (DESKTOP_DIAG ? DESKTOP_DIAG.preview(target) : Promise.resolve(localDiag.preview(target))),
  resetInstall: () => (DESKTOP_DIAG ? DESKTOP_DIAG.resetInstall() : Promise.resolve(localDiag.resetInstall())),
  onChange: (l: () => void) => (DESKTOP_DIAG ? DESKTOP_DIAG.onChange(l) : localDiag.onChange(l)),
};

export async function refreshDiag(): Promise<void> {
  try {
    useDiag.setState({ view: await host.state() });
  } catch {
    // diagnostics never get in the way
  }
}

/** Where the user goes, as breadcrumbs: views, opened threads (their numeric id), dialogs, settings tabs. */
function trackNavigation(): void {
  useApp.subscribe((s, prev) => {
    if (s.view !== prev.view || s.categoryId !== prev.categoryId || (s.query !== "") !== (prev.query !== "")) {
      breadcrumb("nav", "nav.view", { view: s.query ? "search" : s.categoryId ? "category" : (s.view as FieldValueOf<"view">) });
    }
    if (s.selectedId !== prev.selectedId && s.selectedId !== null) breadcrumb("nav", "nav.thread", { threadId: s.selectedId });
    if (s.dialog !== prev.dialog && s.dialog) breadcrumb("ui", "ui.dialog", { dialog: s.dialog });
    if (s.dialog === "settings" && s.settingsTab !== prev.settingsTab) breadcrumb("ui", "ui.settings_tab", { tab: s.settingsTab });
  });
}

let started = false;
/** Once, at boot: the host's view, its change events, and (without a shell) the policy from settings. */
export function startDiag(): void {
  if (started) return;
  started = true;
  trackNavigation();
  host.onChange(() => void refreshDiag());
  if (!DESKTOP_DIAG) {
    void startLocalDiag().then(refreshDiag);
    const follow = (s = getApp().settings) => s && localDiag.setPolicy({ localMode: s.localMode, errorReports: s.errorReports ?? "ask" });
    follow();
    useApp.subscribe((s, prev) => s.settings !== prev.settings && follow(s.settings));
  } else void refreshDiag();
}

export async function decideReports(ids: string[], decision: "send" | "dismiss"): Promise<void> {
  if (!ids.length) return;
  const { sent } = await host.decide(ids, decision);
  if (decision === "send") {
    if (sent) snack.success(t("diag.sent", { count: sent }));
    else snack.error(t("diag.sendFailed"));
  }
  await refreshDiag();
}

export async function openPreview(target: string): Promise<void> {
  const p = await host.preview(target);
  if (p) useDiag.setState({ preview: { target, ...p } });
}

export function closePreview(): void {
  useDiag.setState({ preview: null });
}

export async function resetInstallId(): Promise<void> {
  await host.resetInstall();
  await refreshDiag();
  const p = useDiag.getState().preview;
  if (p) await openPreview(p.target);
}

/** Desktop: main asks (native dumps are a separate choice) and saves a .zip; web: a .json download. */
export async function exportDiagnostics(): Promise<void> {
  if (DESKTOP_DIAG) {
    const r = await DESKTOP_DIAG.export();
    if (r.status === "saved") snack.success(t("diag.exported"), { description: r.name });
    else if (r.status === "failed") snack.error(t("diag.exportFailed"));
    return;
  }
  const json = await localDiag.exportJson();
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${t("diag.export.fileName", { date: new Date().toISOString().slice(0, 10) })}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function showLogs(): void {
  void DESKTOP_DIAG?.showLogs();
}

export async function restartEngine(): Promise<void> {
  await DESKTOP_DIAG?.restartEngine();
}
