import { translate, type Localized } from "@terno/i18n";
import { create } from "zustand";
import type { FatalCode, WorkerText } from "./protocol";

/**
 * Where this tab stands with the mailbox. Only one tab at a time can hold
 * OPFS's access handles (the leader, by Web Lock); the others wait and can
 * take over.
 */
export type WebPhase = "starting" | "elsewhere" | "taking-over" | "taken" | "ready" | "fatal";

export interface WebLifecycle {
  phase: WebPhase;
  /** what the worker is doing while starting (seeding the demo mailbox) */
  progress: Localized | null;
  code: FatalCode | "CRASHED" | null;
  message: WorkerText | null;
  /** a newer build is installed (service worker) or another tab runs one */
  update: null | { apply: () => void };
  /** the adapter the mailbox lives in */
  storage: string | null;
  /** whether the browser keeps this site's storage under pressure (navigator.storage.persist) */
  persistence: null | { state: "granted" | "denied" | "unsupported"; usage: number | null; quota: number | null };
}

export const useWeb = create<WebLifecycle>(() => ({ phase: "starting", progress: null, code: null, message: null, update: null, storage: null, persistence: null }));
export const setWeb = useWeb.setState;

/** Worker text in the page's language, at render time (a raw error stays as it came). */
export function showText(text: WorkerText): string {
  return typeof text === "string" ? text : translate(text);
}
