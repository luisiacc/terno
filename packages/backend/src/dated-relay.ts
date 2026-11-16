import { namingWords, norm } from "./dated-evidence";

/**
 * Plan 210 (iteration 5, revision 8): a person's ask that a service relays to the reader ("@owenhale requested your review on
 * pingwire/cli#812", "Daniel Ortiz sent you a message: 'Hey Theo, … any chance you'd be up for it?'"), asked for five rounds
 * by the panel's Theo. One local predicate, so the worker's gates (Social and Promotions, the automated cost filter, the
 * 14-day check) and the ask's own check agree: a named human, asking the reader (by name, or "you" in the relay itself),
 * for a concrete action or object, in the same sentence or the block it introduces. A network's own call ("Owen posted",
 * "people you may know", "join the conversation") is none. The service is never marked a person: the relation is passed
 * on (`Relay`) and lets through only an ask quoted from its words. Pure, en and es.
 */
export interface Relay {
  /** who asks, as the mail names them ("@owenhale", "Daniel Ortiz") */
  by: string;
  /** the relay's words: the subject, the sentence and the block it introduces, where an ask it carries is quoted from */
  block: string;
  /** the service's name ("Linkwell"): its own words ("Reply on Linkwell") are no one's ask */
  service: string;
}

/** Accents off, case kept: names stay names, "pidió" is "pidio". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

// a person by name: a handle, or two or three capitalized words ("Daniel Ortiz"); one capitalized word only right before the verb
const HANDLE = String.raw`@[\p{L}\p{N}_.-]{2,39}`;
const NAME = String.raw`\p{Lu}[\p{L}'’-]+(?:[^\S\n]+\p{Lu}[\p{L}'’-]+){0,2}`;
// what relays an ask to the reader, directly ("requested your review", "asked you to", "te pidio")
const ASKS_YOU = String.raw`requested (?:your|a) (?:review|approval|feedback|input|signature|help)|requested changes|(?:asked|asks|is asking) (?:you|for your)|(?:wants|needs) your (?:review|approval|feedback|input|signature|help)|assigned (?:you|it to you)|invited you to (?!connect|follow|join (?:their|his|her|the|our|a)? ?(?:network|community|group|page|conversation))|sent you a (?:message|direct message|DM|request)|messaged you|(?:te|le) (?:pidio|pide|pregunto|pregunta|invito a|envio un mensaje|escribio|asigno)|solicito (?:tu|su) (?:revision|aprobacion|firma|ayuda|opinion)|(?:necesita|quiere) (?:tu|su) (?:revision|aprobacion|firma|ayuda|opinion)`;
const RELAY = new RegExp(String.raw`(?<who>${HANDLE}|${NAME})[^\S\n]+(?:has[^\S\n]+|ha[^\S\n]+)?(?<verb>${ASKS_YOU})`, "u");
/** no one: "Someone requested your review", "You asked…" */
const NOBODY = /^(?:someone|somebody|alguien|you|we|they|it|this|that|your|tu|usted|el|la|un|una|a|an|the|hi|hey|hola|dear)$/iu;
const MESSAGE = /sent you a|messaged you|envio un mensaje|escribio/u;
/** a request in a relayed message itself ("any chance you'd be up for it?", "could you…", "¿puedes…?") */
const ASKS = /[?¿]|\b(?:could you|can you|would you|will you|any chance|are you|do you|please|let me know|puedes|podrias|te gustaria|te animas|me ayudas|por favor|avisame)\b/u;
/** a network's own words: never a concrete thing asked */
const GENERIC = new Set(
  "post posted update updates network people profile connection connections conversation community group page follow follower followers reaction comment message messages notification notifications receiving unsubscribe help reply view email directly settings mensaje mensajes notificaciones publicacion responder ayuda".split(" "),
);

/** Whether some words name a concrete thing: a reference ("#812", "pingwire/cli"), or a word that isn't a network's own. */
function concrete(words: string, skip: ReadonlySet<string>): boolean {
  if (/#\d+|[\w.-]+\/[\w.-]+/u.test(words)) return true;
  return [...namingWords(words)].some((w) => !GENERIC.has(w) && !skip.has(w) && !/\d/.test(w));
}

/**
 * The relay in a mail, or null. `service`: the sender's name ("Codeforge"), never the one who asks; `reader`: the reader's
 * name, for "Hey Theo" in a message relayed.
 */
export function relayedAsk(subject: string, text: string, service: string, reader: string): Relay | null {
  const blocks = fold(text).split(/\n\s*\n/u);
  const first = norm(reader).split(" ")[0] ?? "";
  const own = new Set([...namingWords(service), ...namingWords(reader)]);
  const lines = [fold(subject), ...blocks];
  for (const [i, line] of lines.entries()) {
    const m = RELAY.exec(line);
    if (!m) continue;
    const who = m.groups!.who!.trim();
    // nobody, or the service itself ("Linkwell invited you…")
    if (NOBODY.test(who) || norm(who) === norm(service) || namingWords(service).has(norm(who).split(" ")[0] ?? "")) continue;
    // the subject's relay carries the mail's first blocks; a block's, itself and the next
    const at = i === 0 ? 0 : i - 1;
    const block = [fold(subject), ...blocks.slice(at, at + (i === 0 ? 3 : 2))].join("\n\n");
    if (MESSAGE.test(norm(m.groups!.verb!))) {
      // a message: it asks the reader something, by name or as "you", and says what
      const read = ` ${norm(block)} `;
      if (!ASKS.test(block.toLowerCase()) || !(read.includes(` ${first} `) || /\b(?:you|your|tu|te|usted)\b/u.test(read))) continue;
      if (!concrete(block.replace(line, i === 0 ? "" : line.slice(0, m.index)), new Set([...own, ...namingWords(who)]))) continue;
      return { by: who, block, service };
    }
    if (!concrete(line.slice(m.index + m[0].length), own)) continue;
    return { by: who, block, service };
  }
  return null;
}

/** Whether a subject may carry a relay ("Daniel Ortiz sent you a message", "Review requested: …"): Social mail waits for its body only then. */
export function mayRelay(subject: string): boolean {
  return RELAY.test(fold(subject)) || /\b(?:review requested|requested your|sent you a|messaged you|asked you|invited you|wants your|needs your|te envio|te pidio|te escribio|solicito tu)\b/iu.test(fold(subject));
}

/** Whether an ask's quote is the relay's own words (its block), as `norm` reads both. */
export function relays(relay: Relay | null | undefined, quote: string): boolean {
  const q = norm(fold(quote));
  const service = [...namingWords(relay?.service ?? "")];
  return !!relay && !!q && norm(relay.block).includes(q) && !service.some((w) => ` ${q} `.includes(` ${w} `));
}
