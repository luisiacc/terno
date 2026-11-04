import { normalizeText } from "../text";

/**
 * Plan 133 §5, as a pure decision: from a sentence to where the draft goes. Compose code acts on the result; nothing
 * here touches it. Anything that would show someone mail or files they haven't seen comes back as a question.
 */

export interface IntentPerson {
  name: string;
  address: string;
}

export interface ContactLookup {
  /** not ready is never read as "no such person" */
  state: "ready" | "cold";
  hits: IntentPerson[];
}

export type IntentSurface =
  | {
      kind: "thread";
      /** everyone besides the user, for "Include everyone (3)" */
      participants: readonly IntentPerson[];
      /** who an ordinary reply would answer */
      lastSender: string | null;
    }
  | { kind: "list" }
  | { kind: "draft"; recipients: readonly IntentPerson[] };

export interface IntentInput {
  instruction: string;
  surface: IntentSurface;
  /** exact name-token lookup across contacts (`ContactIndex.resolveExact`) */
  lookup: (token: string) => ContactLookup;
  /** a thread with this address in the last 30 days */
  recentThread?: (address: string) => { threadId: number; subject: string } | null;
  /** what `parseIntent` said, on the second pass: an address, or null for "nobody" */
  confirmed?: string | null;
}

export type IntentDecision =
  /** the index isn't warm: the row says "Looking up Tom…" and asks again */
  | { kind: "wait"; tokens: string[] }
  /** a name matched and the route would change: one small `parseIntent`, then decide again with `confirmed` */
  | { kind: "confirm"; candidates: IntentPerson[] }
  | { kind: "route"; route: IntentRoute }
  | { kind: "ask"; question: IntentQuestion };

export type IntentRoute =
  /** answering that person's newest message, to them alone; everyone is one click away */
  | { type: "reply"; to: IntentPerson | null; answering: string | null; includeEveryone: number }
  | { type: "new"; to: IntentPerson }
  /** the draft's recipients don't change: the instruction shapes the wording */
  | { type: "keep-draft" }
  /** the draft had nobody on it yet */
  | { type: "fill-draft"; to: IntentPerson };

export type IntentQuestion =
  /** forwarding adds the original and its files, so it's never a default */
  | { type: "forward-or-new"; to: IntentPerson }
  | { type: "new-or-reply"; to: IntentPerson; thread: { threadId: number; subject: string } }
  | { type: "add-or-just-write"; to: IntentPerson }
  | { type: "who" };

const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u;
/** a word this short names nobody, in any language */
const MIN_NAME_LENGTH = 2;
const MAX_WORDS = 24;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function nameTokens(name: string): string[] {
  return normalizeText(name).split(/[^\p{L}\p{N}'’-]+/u).filter((t) => t.length >= MIN_NAME_LENGTH);
}

function instructionWords(instruction: string): string[] {
  const words = normalizeText(instruction).split(/[^\p{L}\p{N}'’-]+/u).filter((w) => w.length >= MIN_NAME_LENGTH);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

function uniquePeople(people: readonly IntentPerson[]): IntentPerson[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function routeTo(person: IntentPerson, input: IntentInput): IntentDecision {
  const { surface } = input;
  if (surface.kind === "thread") {
    const participant = surface.participants.find((p) => sameAddress(p.address, person.address));
    if (!participant) return { kind: "ask", question: { type: "forward-or-new", to: person } };
    return { kind: "route", route: { type: "reply", to: participant, answering: participant.address, includeEveryone: surface.participants.length } };
  }
  if (surface.kind === "draft") {
    if (surface.recipients.length === 0) return { kind: "route", route: { type: "fill-draft", to: person } };
    if (surface.recipients.some((p) => sameAddress(p.address, person.address))) return { kind: "route", route: { type: "keep-draft" } };
    return { kind: "ask", question: { type: "add-or-just-write", to: person } };
  }
  const thread = input.recentThread?.(person.address) ?? null;
  if (thread) return { kind: "ask", question: { type: "new-or-reply", to: person, thread } };
  return { kind: "route", route: { type: "new", to: person } };
}

function nobody(input: IntentInput): IntentDecision {
  const { surface } = input;
  if (surface.kind === "thread") return { kind: "route", route: { type: "reply", to: null, answering: surface.lastSender, includeEveryone: surface.participants.length } };
  if (surface.kind === "draft") return { kind: "route", route: { type: "keep-draft" } };
  return { kind: "ask", question: { type: "who" } };
}

/** Whether acting on this person differs from what would happen with no name at all. */
function wouldChangeRoute(person: IntentPerson, surface: IntentSurface): boolean {
  if (surface.kind === "list") return true;
  if (surface.kind === "draft") return !surface.recipients.some((p) => sameAddress(p.address, person.address));
  // an ordinary reply already goes to them
  return surface.lastSender === null || !sameAddress(person.address, surface.lastSender);
}

export function resolveIntent(input: IntentInput): IntentDecision {
  const { surface, instruction } = input;

  // the second pass: the model has said who it's for
  if (input.confirmed !== undefined) {
    if (input.confirmed === null) return nobody(input);
    const known = surface.kind === "thread" ? surface.participants : surface.kind === "draft" ? surface.recipients : [];
    const person = known.find((p) => sameAddress(p.address, input.confirmed!)) ?? { name: "", address: input.confirmed };
    return routeTo(person, input);
  }

  const address = ADDRESS.exec(instruction)?.[0];
  if (address) {
    const known = surface.kind === "thread" ? surface.participants : surface.kind === "draft" ? surface.recipients : [];
    return routeTo(known.find((p) => sameAddress(p.address, address)) ?? { name: "", address: address.toLowerCase() }, input);
  }

  const words = instructionWords(instruction);
  // the open thread's people first: they're who a sentence on this thread most likely means
  const local = surface.kind === "thread" ? surface.participants : surface.kind === "draft" ? surface.recipients : [];
  const localHits = local.filter((p) => nameTokens(p.name).some((t) => words.includes(t)));
  const cold: string[] = [];
  const contactHits: IntentPerson[] = [];
  for (const word of words) {
    const result = input.lookup(word);
    if (result.state === "cold") cold.push(word);
    else contactHits.push(...result.hits);
  }
  const candidates = uniquePeople(localHits.length ? localHits : contactHits);
  // a matched participant is enough to go on; otherwise "not ready" can't be read as "nobody"
  if (cold.length > 0 && localHits.length === 0) return { kind: "wait", tokens: cold };
  if (candidates.length === 0) return nobody(input);
  // "Mark the invoice as paid": a match alone never changes a route
  if (candidates.length === 1 && !wouldChangeRoute(candidates[0]!, surface)) return routeTo(candidates[0]!, input);
  return { kind: "confirm", candidates };
}
