/**
 * Terno's strings. One active locale per JavaScript realm (the page, the
 * backend, main): t() reads it, setLocale() changes it. English is the
 * source of truth and the fallback for anything a locale lacks.
 */
import { compile, renderRich, renderText, type Part } from "./format";
import en from "./locales/en";
import { DEFAULT_LOCALE, LOCALES, LOCALE_IDS, type LocaleId } from "./locales/index";
import type { Key, Message, Messages, ParamsArg, Plural, RichKey, RichParams, TextKey } from "./types";

export { LOCALES, LOCALE_IDS, DEFAULT_LOCALE, type LocaleId };
export type { Key, Message, Messages, Params, ParamsArg, Plural, RichKey, RichParams, TextKey, LocaleCheck, Catalog } from "./types";

/** The language setting: follow the system, or one of LOCALE_IDS. */
export type LanguageSetting = "system" | LocaleId;
export const LANGUAGE_SETTINGS = ["system", ...LOCALE_IDS] as const;

const english: Messages = en;
let locale: LocaleId = DEFAULT_LOCALE;
let messages: Messages = english;
let compiled = new Map<string, readonly Part[]>();
let plurals: Intl.PluralRules | null = null;
let numbers: Intl.NumberFormat | null = null;
const listeners = new Set<(locale: LocaleId) => void>();

export function getLocale(): LocaleId {
  return locale;
}

/** The BCP 47 tag of the active locale ("en-US", "es-MX"). */
export function localeTag(id: LocaleId = locale): string {
  return LOCALES[id].tag;
}

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && Object.hasOwn(LOCALES, value);
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "system" || isLocaleId(value);
}

/**
 * The locale a setting means: an explicit language wins; "system" takes the
 * first system language Terno has ("es-MX" → es), else English.
 */
export function resolveLocale(setting: unknown, systemLanguages: readonly string[]): LocaleId {
  if (isLocaleId(setting)) return setting;
  for (const tag of systemLanguages) {
    const base = String(tag).toLowerCase().split(/[-_]/)[0];
    if (isLocaleId(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Makes a loaded catalog the active one (synchronous: callers load first). */
export function setLocale(id: LocaleId, catalog: Messages): void {
  if (id === locale && catalog === messages) return;
  locale = id;
  messages = catalog;
  compiled = new Map();
  plurals = null;
  numbers = null;
  for (const listener of listeners) listener(id);
}

/** Loads a locale's catalog (English: already here) and makes it active. */
export async function loadLocale(id: LocaleId): Promise<void> {
  const catalog = await LOCALES[id].load();
  setLocale(id, catalog);
}

/** Called after every locale change (date formatters rebuild here). */
export function onLocaleChange(listener: (locale: LocaleId) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  if (options) return new Intl.NumberFormat(localeTag(), options).format(n);
  numbers ??= new Intl.NumberFormat(localeTag());
  return numbers.format(n);
}

export function formatList(items: readonly string[], type: Intl.ListFormatType = "conjunction"): string {
  return new Intl.ListFormat(localeTag(), { style: "long", type }).format(items);
}

const formatCount = (n: number) => formatNumber(n);

function pluralText(m: Plural, count: unknown, rules: () => Intl.PluralRules): string {
  const n = typeof count === "number" ? count : Number(count);
  const exact = m[`=${n}` as "=0"];
  if (exact !== undefined) return exact;
  return m[rules().select(Number.isFinite(n) ? n : 0)] ?? m.other;
}

const activeRules = () => (plurals ??= new Intl.PluralRules(localeTag()));

function parts(key: string, values: Readonly<Record<string, unknown>> | undefined): readonly Part[] | string {
  const m: Message = messages[key] ?? english[key] ?? key;
  const plural = typeof m === "object";
  const text = plural ? pluralText(m, values?.count, activeRules) : m;
  if (!plural && !/[{<]/.test(text)) return text;
  const id = plural ? key + "\u0000" + text : key;
  let p = compiled.get(id);
  if (!p) {
    p = compile(text, plural);
    compiled.set(id, p);
  }
  return p;
}

/** A message in the active locale, with its placeholders filled in (numbers formatted for the locale). */
export function t<K extends TextKey>(key: K, ...args: ParamsArg<K>): string {
  const values = args[0] as Readonly<Record<string, unknown>> | undefined;
  const p = parts(key, values);
  return typeof p === "string" ? p : renderText(p, refs(values, messages), formatCount);
}

/**
 * A message to be shown by another realm (the backend's errors and reasons
 * are rendered by the renderer, in its locale). `message` is the English
 * text, for logs, agents and tests.
 */
export interface Localized {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly message: string;
}

let englishRules: Intl.PluralRules | null = null;
const englishNumbers = new Intl.NumberFormat(LOCALES.en.tag);

export function L<K extends TextKey>(key: K, ...args: ParamsArg<K>): Localized {
  const params = args[0] as Readonly<Record<string, string | number>> | undefined;
  const m: Message = english[key] ?? key;
  const text = typeof m === "object" ? pluralText(m, params?.count, () => (englishRules ??= new Intl.PluralRules(LOCALES.en.tag))) : m;
  const message = renderText(compile(text, typeof m === "object"), refs(params, english), (n) => englishNumbers.format(n));
  return params ? { key, params, message } : { key, message };
}

const REF = /^([\w.-]+)$/;

/**
 * A placeholder value that is itself a message ("Custom", "Offline demo"
 * inside an error the backend phrases): rendered in the language of the
 * message it fills, so a descriptor's params translate too.
 */
export function keyRef(key: TextKey): string {
  return `${key}`;
}

/** The value as plain English text (a keyRef resolved), for messages that aren't descriptors. */
export function plainText(value: string): string {
  const m = REF.exec(value);
  const ref = m && english[m[1]!];
  return typeof ref === "string" ? ref : value;
}

/** The value as text in the active locale: a keyRef that came over the wire (a model's label) translated, anything else as is. */
export function refText(value: string): string {
  const m = REF.exec(value);
  const ref = m && (messages[m[1]!] ?? english[m[1]!]);
  return typeof ref === "string" ? ref : value;
}

function refs(values: Readonly<Record<string, unknown>> | undefined, catalog: Messages): Readonly<Record<string, unknown>> {
  if (!values) return {};
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(values)) {
    const m = typeof v === "string" ? REF.exec(v) : null;
    if (!m) continue;
    const ref = catalog[m[1]!] ?? english[m[1]!];
    out ??= { ...values };
    out[k] = typeof ref === "string" ? ref : m[1];
  }
  return out ?? values;
}

/** Whether a value is a descriptor (from the wire or storage: checked, never trusted). */
export function isLocalized(value: unknown): value is Localized {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || (v.params !== undefined && (typeof v.params !== "object" || v.params === null))) return false;
  return v.params === undefined || Object.values(v.params).every((x) => typeof x === "string" || typeof x === "number");
}

/** A descriptor in the active locale; an unknown key shows the message it came with. */
export function translate(d: { key: string; params?: Readonly<Record<string, string | number>>; message?: string }): string {
  if (!hasKey(d.key)) return d.message ?? d.key;
  const p = parts(d.key, d.params);
  return typeof p === "string" ? p : renderText(p, refs(d.params, messages), formatCount);
}

/** A message with rich text: each `<tag>` goes through its renderer. Text runs are merged. */
export function rich<K extends RichKey, R>(key: K, params: RichParams<K, R>): (string | R)[] {
  const values = params as Readonly<Record<string, unknown>>;
  const p = parts(key, values);
  return typeof p === "string" ? [p] : renderRich<R>(p, values, formatCount);
}

/** Whether a key exists in English (for code that maps runtime strings to keys). */
export function hasKey(key: string): key is Key {
  return Object.hasOwn(english, key);
}
