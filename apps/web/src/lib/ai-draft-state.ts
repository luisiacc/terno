import { BODY_GLANCE_MAX, readBody } from "@terno/core";
import { create } from "zustand";
import { docRange } from "~/components/composer/body-text";
import { controllerFor } from "~/components/composer/controller";
import { client } from "~/rpc/connection";
import { draftingOffered } from "./ai";
import { getApp, useApp } from "~/state/app";

/**
 * Plan 133: AI drafting's state, which the send path can import without depending on `lib/ai-draft.ts` (that imports
 * the send path): whether it's on, which drafts have its row up, and the hooks `lib/ai-draft.ts` fills in.
 */

/**
 * `open`: the row or strip is up; `writing`: a draft is on its way; `ready`: one waits for the draft to be opened again;
 * `primed` (plan 163): ⌘J opened it for AI, and nothing has run: no work to keep a blank draft for; `failed` (plan 162):
 * the row says it couldn't write, and no draft of its own has landed (the body is what they typed)
 */
export type AiDraftBadge = "open" | "writing" | "ready" | "primed" | "failed";

/**
 * Plan 163: what ⌘J would do with a draft's body, read on this machine (`readBody`, rules only): `write` from an instruction,
 * `fill:<n>` gaps, `empty`, `unsure` (the rules can't tell), or "" (the user's own email).
 */
export type BodyGlance = "" | "empty" | "write" | "unsure" | `fill:${number}`;

export const useAiDraftUi = create<{ enabled: boolean; rows: Readonly<Record<string, AiDraftBadge>>; stylePage: boolean; glances: Readonly<Record<string, BodyGlance>> }>(() => ({ enabled: true, rows: {}, stylePage: false, glances: {} }));

/**
 * Plan 162 (after ai162-r04): the body is a note for AI, not the email: it reads as an instruction, or ⌘J opened the
 * composer for AI and what's typed isn't plainly an email. Never while AI works on it or over its draft (the strip).
 * A failure before a draft landed leaves it one (plan 162, after the real-model comparison: "Couldn't reach Claude" left
 * the instruction as plain text with Send the primary, one click from mailing it).
 */
export function noteState(row: AiDraftBadge | undefined, glance: BodyGlance | undefined): boolean {
  if (row !== undefined && row !== "primed" && row !== "failed") return false;
  return glance === "write" || (row !== undefined && glance === "unsure");
}

/** What ⌘J would do with the body as it is now (rules only, up to the glance's limit); null with no editor. */
export function glanceNow(key: string): BodyGlance | null {
  const c = controllerFor(key);
  if (!c) return null;
  const b = c.bodyText(BODY_GLANCE_MAX);
  const read = readBody(b.text, { images: b.images, limit: BODY_GLANCE_MAX });
  const gaps = read.kind === "email" ? read.gaps.filter((g) => docRange(b, g.from, g.to) !== null).length : 0;
  return read.kind === "empty" ? "empty" : read.kind === "instruction" ? "write" : gaps ? `fill:${gaps}` : read.kind === "unsure" ? "unsure" : "";
}

/**
 * Send's question: read from the body at the moment of the send, never the glance (it follows typing by up to 150 ms, so
 * an instruction pasted and sent at once would go as the email: Codex review).
 */
export const isNote = (key: string): boolean => {
  const s = useAiDraftUi.getState();
  return canDraft() && noteState(s.rows[key], glanceNow(key) ?? s.glances[key]);
};

export function useNote(key: string | undefined): boolean {
  const offered = useCanDraft();
  return useAiDraftUi((s) => offered && key !== undefined && noteState(s.rows[key], s.glances[key]));
}

export function setGlance(key: string, glance: BodyGlance | null): void {
  const { glances } = useAiDraftUi.getState();
  if ((glances[key] ?? null) === glance) return;
  const next = { ...glances };
  if (glance === null) delete next[key];
  else next[key] = glance;
  useAiDraftUi.setState({ glances: next });
}

/**
 * Plan 162 (after ai162-r05): the glance read now, where one is published (the body's slot is up), for a change that isn't
 * typing: an Undo that gives the note back must say so in the same moment, not a glance later (a frame of Send as the
 * primary under the instruction).
 */
export function refreshGlance(key: string): void {
  if (!(key in useAiDraftUi.getState().glances)) return;
  setGlance(key, glanceNow(key) ?? "");
}

export const aiDraftHooks: {
  /** a suggestion nobody has decided on: the row asks, and this send stops here (§10.4) */
  blocksSend: (key: string, sendAt?: number) => boolean;
  /** waits until what was committed has its provenance row, so the send can be compared with it */
  provenance: (key: string) => Promise<void>;
  /** Esc in the form: true when the row took it */
  escape: (key: string) => boolean;
  /** a preview is up: no ghost text under it */
  busy: (key: string) => boolean;
  /** its AI work is still there to come back to: it returns open, on its own (§10.4) */
  working: (key: string) => boolean;
} = {
  blocksSend: () => false,
  provenance: () => Promise.resolve(),
  escape: () => false,
  busy: () => false,
  working: () => false,
};

/** Plan 147: the feature's own switch, and whether it can run at all. */
export const canDraft = (): boolean => useAiDraftUi.getState().enabled && draftingOffered(getApp());

export function useCanDraft(): boolean {
  const enabled = useAiDraftUi((s) => s.enabled);
  return useApp(draftingOffered) && enabled;
}

/** Whether the feature shows, read once at boot; Settings keeps it current. No side effects, as the contract promises. */
export async function loadDraftingEnabled(): Promise<void> {
  try {
    const prefs = await client.call("writing.prefs.get", {});
    useAiDraftUi.setState({ enabled: prefs.global.enabled });
  } catch {
    /* it stays on: asking is what would say otherwise, with the reason */
  }
}
