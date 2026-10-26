import { formatAddress, isNoReply, isValidEmail, parseAddressList, repairAddresses, type Address } from "@terno/core";
import { tokenAt } from "./recipients";

/**
 * A recipient field as chips (plan 34): the committed recipients, what is
 * being typed, and where a commit goes. Pure, so every key's outcome is
 * unit-tested; the field's text (`serialize`) stays the draft's model, so
 * drafts, autosave and conversions are unchanged and nothing is migrated.
 */

/** Send asks a field (the DOM event on it) to show its first invalid recipient (plan 34 §2.6). */
export const SELECT_INVALID = "terno:recipient-select-invalid";

export interface Chip {
  /** stable identity for React and the selection (not stored) */
  key: number;
  address: Address;
  valid: boolean;
  /** how it is written in the field's text: formatAddress (an entry that isn't an address stays one quoted entry) */
  text: string;
}

export interface FieldState {
  chips: readonly Chip[];
  /** the input's text: what is being typed */
  text: string;
  /** where a commit goes among the chips (an edited chip goes back to its place) */
  at: number;
}

let nextKey = 1;

export function chip(address: Address): Chip {
  const a = { name: address.name.trim(), email: address.email.trim() };
  return { key: nextKey++, address: a, valid: isValidEmail(a.email), text: formatAddress(a) };
}

export const EMPTY: FieldState = { chips: [], text: "", at: 0 };

/** What a chip shows: the name, or the address when there is none. */
export const chipLabel = (c: Chip): string => c.address.name || c.address.email;

/** "Björn Peña, bjorn.pena@acme.studio" (what a screen reader and the tooltip say). */
export const chipName = (c: Chip): string => (c.address.name ? `${c.address.name}, ${c.address.email}` : c.address.email);

export const chipNoReply = (c: Chip): boolean => c.valid && isNoReply(c.address.email);

/** The text a chip turns back into when it is edited. */
export const chipEditText = (c: Chip): string => (c.valid || c.address.name ? formatAddress(c.address) : c.address.email);

/**
 * A field's text read into chips. While the field has focus, a last entry
 * with no separator after it, still being completed, stays text; otherwise
 * everything is a chip.
 */
export function derive(value: string, focused: boolean): FieldState {
  if (!value.trim()) return EMPTY;
  const tail = tokenAt(value, value.length);
  // (a complete `Name <addr>` is a chip either way: nothing in it to complete)
  const typing = focused && tail.query !== "";
  const committed = typing ? value.slice(0, tail.start) : value;
  const chips = parseAddressList(committed).map(chip);
  return { chips, text: typing ? value.slice(tail.start).replace(/^\s+/, "") : "", at: chips.length };
}

/** The field's text: the chips as written, with what is being typed in its place. */
export function serialize(s: FieldState): string {
  const parts = s.chips.map((c) => c.text);
  if (s.text.trim()) parts.splice(Math.min(s.at, parts.length), 0, s.text.trim());
  return parts.join(", ");
}

/** The lowercased addresses of chips (valid or not). */
const keysOf = (chips: readonly Chip[]) => new Set(chips.map((c) => c.address.email.toLowerCase()));

/**
 * `list` added as chips at the commit place: what is already in this field
 * (or in `others`) isn't added twice; entries that aren't addresses are kept
 * (they show as invalid chips, never silently dropped). Returns the new state
 * and the addresses the user put in (they are no longer Terno's auto ones).
 */
export function insert(s: FieldState, list: readonly Address[], others: Iterable<string> = []): { state: FieldState; added: Address[] } {
  const seen = keysOf(s.chips);
  for (const e of others) seen.add(e.toLowerCase());
  const added: Address[] = [];
  for (const a of list) {
    const key = a.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(a);
  }
  const at = Math.min(s.at, s.chips.length);
  const chips = [...s.chips.slice(0, at), ...added.map(chip), ...s.chips.slice(at)];
  return { state: { chips, text: "", at: at + added.length }, added };
}

/** What was typed, committed: one or several chips ("a@x.com b@y.com"), cleaned as a paste would be. */
export function commit(s: FieldState): { state: FieldState; added: Address[] } {
  if (!s.text.trim()) return { state: { ...s, text: "", at: s.chips.length }, added: [] };
  const { state, added } = insert(s, typedAddresses(s.text));
  return { state: { ...state, at: state.chips.length }, added };
}

/**
 * Typed or pasted text as addresses: smart quotes, `mailto:`, invisible
 * characters cleaned (never split out of a name); entries that aren't
 * addresses kept as they were written.
 */
export function typedAddresses(text: string): Address[] {
  return parseAddressList(text).flatMap((a) => (isValidEmail(a.email) ? repairAddresses([a], { split: false }) : [a]));
}

/** Chips removed by key; the commit place follows. */
export function remove(s: FieldState, keys: ReadonlySet<number>): FieldState {
  const before = s.chips.slice(0, s.at).filter((c) => keys.has(c.key)).length;
  return { chips: s.chips.filter((c) => !keys.has(c.key)), text: s.text, at: Math.max(0, s.at - before) };
}

/** A chip turned back into text, its place kept for the commit (what was being typed is committed first). */
export function edit(s: FieldState, key: number): FieldState {
  const first = commit(s).state;
  const i = first.chips.findIndex((c) => c.key === key);
  if (i < 0) return first;
  return { chips: first.chips.filter((c) => c.key !== key), text: chipEditText(first.chips[i]!), at: i };
}

/** The first entry that isn't an address, for Send's message. */
export function firstInvalid(text: string): string | null {
  const bad = parseAddressList(text).find((a) => !isValidEmail(a.email));
  return bad ? bad.email || bad.name : null;
}

/** "Ana, Bob and 12 more" (the unfocused summary, the collapsed draft): names before the count. */
export function summaryNames(chips: readonly Chip[], shown: number): string[] {
  return chips.slice(0, shown).map((c) => (c.address.name ? c.address.name.split(/\s+/)[0]! : c.address.email));
}
