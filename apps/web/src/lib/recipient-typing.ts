import { create } from "zustand";
import { firstInvalid, serialize, type FieldState } from "./recipient-field";

/**
 * Plan 205: the entry a recipient field is still being typed into isn't wrong yet. Send stays strict (`firstInvalid`
 * on the whole text); only what's said before Send (the drafts strip's line, Send's tooltip) leaves that entry out.
 */
export type RecipientField = "to" | "cc" | "bcc";

/** A field while an entry is typed in it: its text as it stands, and the same text without that entry. */
export interface Typing {
  value: string;
  rest: string;
}

type DraftTyping = Partial<Record<RecipientField, Typing>>;
type Fields = { toText: string; ccText: string; bccText: string };

/** Per draft key; never stored: a draft opened again has nothing being typed. */
export const useRecipientTyping = create<Record<string, DraftTyping>>(() => ({}));

/** What a field's state says is being typed: its uncommitted text, wherever it sits (an edited chip keeps its place). */
export function typingOf(s: FieldState): Typing | null {
  return s.text.trim() ? { value: serialize(s), rest: serialize({ ...s, text: "" }) } : null;
}

/** The field's own input events publish here; a commit, a blur or Send end it (`null`). */
export function setTyping(key: string, field: RecipientField, typing: Typing | null): void {
  const was = useRecipientTyping.getState()[key];
  if (!typing && !was?.[field]) return;
  const next: DraftTyping = { ...was };
  if (typing) next[field] = typing;
  else delete next[field];
  useRecipientTyping.setState((s) => {
    const all = { ...s };
    if (Object.keys(next).length) all[key] = next;
    else delete all[key];
    return all;
  }, true);
}

/** Send ends the typing in every field of the draft: what's wrong is said again. */
export function endTyping(key: string): void {
  if (!useRecipientTyping.getState()[key]) return;
  useRecipientTyping.setState((s) => {
    const all = { ...s };
    delete all[key];
    return all;
  }, true);
}

/**
 * The first entry that isn't an address, as said before Send: the one being typed left out. A typing note for other
 * text than the draft's (a change from elsewhere since) counts for nothing: the whole text is checked.
 */
export function shownInvalid(d: Fields, typing: DraftTyping | undefined): string | null {
  for (const field of ["to", "cc", "bcc"] as const) {
    const text = d[`${field}Text`];
    const typed = typing?.[field];
    const bad = firstInvalid(typed && typed.value === text ? typed.rest : text);
    if (bad !== null) return bad;
  }
  return null;
}
