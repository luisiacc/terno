/**
 * Plan 161, pass 3: whether what's typed in ⌘K is plainly an instruction to do something to mail ("Archive shipping
 * notices older than a month"), so the palette offers it to AI first. Plainly: it starts with a verb of the action set
 * (with the word a move or a mark needs after it), runs to four words or more, and holds no search operator or quotes.
 * A search ("invoice March", "from:ana archive"), one verb ("archive"), or a name that starts like one ("Mark Twain
 * letters") keeps the search first.
 */
const VERB = [
  // archive, delete, trash, and their Spanish
  /^(?:archive|delete|trash|archiva|archivar|borra|borrar|elimina|eliminar)\s/i,
  // a move or a filing names where to
  /^(?:move|file|send|mueve|mover|manda|mandar)\s.+\s(?:to|into|under|in|a|al|en)\s\S/i,
  // a mark says as what
  /^(?:mark|marca|marcar)\s.+\s(?:as|como)\s\S/i,
];
const MIN_WORDS = 4;

export function isInstruction(text: string): boolean {
  const s = text.trim();
  if (/[:"“”«»]/.test(s)) return false;
  // a phrase in single quotes is a search's too (Codex review, pass 3): a quote opening a word; an apostrophe inside one isn't
  if (/(?:^|[\s(])['‘’]/.test(s)) return false;
  if (s.split(/\s+/).length < MIN_WORDS) return false;
  return VERB.some((re) => re.test(s));
}
