import { normalizeText } from "../text";

/**
 * Plan 133 §3: a judgment's notes are the only free text the model leaves in a profile. This screen reduces the risk
 * they carry a detail, and proves nothing: a paraphrase of "her chemo" passes it, which is why the notes are visible,
 * editable, and measured by canaries in the eval.
 */

export const MAX_NOTES = 4;
export const MAX_NOTE_WORDS = 14;
const COPIED_RUN = 4;
/** a word this long, seen in the sample only about one person's mail, reads as a subject rather than a manner */
const TOPIC_WORD_LENGTH = 4;

const words = (text: string) => normalizeText(text).match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];

export interface ScreenSample {
  text: string;
  to: readonly string[];
}

export type NoteRejection = "digits" | "address" | "url" | "too-long" | "copied" | "topic";

export function rejectNote(note: string, sample: readonly ScreenSample[]): NoteRejection | null {
  if (/\d/.test(note)) return "digits";
  if (/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+/u.test(note)) return "address";
  if (/\b(?:https?:\/\/|www\.)|\b[\p{L}\p{N}-]+\.(?:com|org|net|io|dev|app|es|mx|co|example)\b/iu.test(note)) return "url";
  const noteWords = words(note);
  if (noteWords.length > MAX_NOTE_WORDS) return "too-long";
  const haystacks = sample.map((m) => ` ${words(m.text).join(" ")} `);
  for (let i = 0; i + COPIED_RUN <= noteWords.length; i++) {
    const run = ` ${noteWords.slice(i, i + COPIED_RUN).join(" ")} `;
    if (haystacks.some((h) => h.includes(run))) return "copied";
  }
  // a word that only ever came up with one recipient is a subject of that correspondence, not how someone writes
  const recipients = new Map<string, Set<string>>();
  sample.forEach((m, i) => {
    for (const w of new Set(haystacks[i]!.trim().split(" "))) {
      let seen = recipients.get(w);
      if (!seen) recipients.set(w, (seen = new Set()));
      for (const r of m.to) seen.add(r);
    }
  });
  const distinct = new Set(sample.flatMap((m) => m.to)).size;
  if (distinct >= 2) {
    for (const w of noteWords) {
      if (w.length >= TOPIC_WORD_LENGTH && recipients.get(w)?.size === 1) return "topic";
    }
  }
  return null;
}

/** Notes that pass, at most 4; what didn't is reported so the eval can measure the screen. */
export function screenNotes(notes: readonly string[], sample: readonly ScreenSample[]): { kept: string[]; rejected: { note: string; reason: NoteRejection }[] } {
  const kept: string[] = [];
  const rejected: { note: string; reason: NoteRejection }[] = [];
  for (const raw of notes) {
    const note = raw.trim();
    if (!note) continue;
    const reason = rejectNote(note, sample);
    if (reason) rejected.push({ note, reason });
    else if (kept.length < MAX_NOTES) kept.push(note);
  }
  return { kept, rejected };
}
