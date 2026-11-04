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
/**
 * What a note about manner is made of. Without this the topic check took out 21 of 88 notes on real output, all of them
 * good ("Leads with the answer"), because most words in a small sample are only ever sent to one person.
 */
const MANNER_WORDS: ReadonlySet<string> = new Set(
  `about after always answer answers aside asides articles asks asking before brief briefly caveat caveats capital capitals casual clause clauses clipped close closes closing comma commas compact condition conditions detail details direct directly drop drops dropping dry ends exclamation exclamations facts first fixed filler formal formally frequent frequently friendly from gets gives goes gratitude greeting greetings hedge hedging informal instead instruction instructions into joke jokes keeps lead leading leads line lines long longer lowercase marks message messages moves mostly name names never offer offers often only open opening opens padded padding paragraph paragraphs period periods phrase phrases plain plainly plainly point pleasantries practical preamble punctuation question questions rarely rather reason reasons recipient recipients register repeat repeats request requests rhythm says sentence sentences short shorter sign-off signoff signs soften softener softeners softening softens some sometimes starts state statement states stays straight structure subjects teasing tease tease teases than that their them then they this tone uses usually warm warmly warmth when with without word words writes
  abre abren anade anadidas apodo asunto breve breves calida calido cierra cierre clientes colegas comentario comentarios completa completas completo completos con cordial corta cortas corto cortos despedida directa directamente directo destinatario destinatarios espanol explica estructura favor firma fija fijo fijas fijos formal formales formula frase frases gracias ingles larga largas largo largos linea lineas mantiene nada nombre nombres ordenado parrafo parrafos personales pregunta preguntas preambulo primera primero protocolaria protocolario razonamiento registro responde respuesta rodeos saludo saludos segun solo suaviza suena tecnico tono tutea tuteo usted`.split(/\s+/),
);

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
      if (w.length >= TOPIC_WORD_LENGTH && !MANNER_WORDS.has(w) && recipients.get(w)?.size === 1) return "topic";
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
