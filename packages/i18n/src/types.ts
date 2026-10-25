import type en from "./locales/en";

/**
 * A message that depends on a number: one full sentence per plural category
 * (Intl.PluralRules), `other` required, `=N` for exact numbers. `#` is the
 * count formatted for the locale; `{count}` works too.
 */
export interface Plural {
  readonly "=0"?: string;
  readonly "=1"?: string;
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Message = string | Plural;
/** What any locale file is at runtime. */
export type Messages = Readonly<Record<string, Message>>;

export type Catalog = typeof en;
export type Key = keyof Catalog;

/** Every string a message can render (a plural's sentences). */
type Texts<M> = M extends string ? M : M extends Plural ? Extract<M[keyof M], string> : never;

/** `{name}` placeholders. */
type Placeholders<S> = S extends `${string}{${infer N}}${infer R}` ? N | Placeholders<R> : never;
/** `<tag>…</tag>` tags (rich text). */
type Tags<S> = S extends `${string}<${infer T}>${infer R}` ? (T extends `/${string}` ? Tags<R> : T | Tags<R>) : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type PlaceholderParams<M> = { [P in Placeholders<Texts<M>>]: string | number } & (M extends Plural ? { count: number } : unknown);

/** The values a key's message takes: `{name}` → string | number; a plural's `count` → number. */
export type Params<K extends Key> = Simplify<PlaceholderParams<Catalog[K]>>;
/** t()'s arguments after the key: none when the message has no placeholders. */
export type ParamsArg<K extends Key> = keyof Params<K> extends never ? [] : [params: Params<K>];

/** rich(): placeholders plus one renderer per tag. */
export type RichParams<K extends Key, R> = Simplify<PlaceholderParams<Catalog[K]> & { [T in Tags<Texts<Catalog[K]>>]: (children: string) => R }>;

/** Keys whose messages have rich tags (rich() only), and the rest (t() and L()). */
export type RichKey = { [K in Key]: Tags<Texts<Catalog[K]>> extends never ? never : K }[Key];
export type TextKey = Exclude<Key, RichKey>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Shape<M> = Placeholders<Texts<M>> | `<${Tags<Texts<M>>}>`;

/** A leaf in a locale file: same kind as English (string or plural) and the same placeholders and tags. */
type LeafCheck<E, S> = E extends string
  ? S extends string
    ? Same<Shape<E>, Shape<S>> extends true
      ? S
      : `✗ placeholders and tags must match en: ${E}`
    : `✗ must be a string like en: ${E}`
  : S extends Plural
    ? Same<Shape<E>, Shape<S>> extends true
      ? S
      : { "✗ placeholders and tags must match en": E }
    : { "✗ must be a plural object like en": E };

/**
 * What a locale file must be: every English key (missing → error), nothing
 * else (extra → never), and each message with English's placeholders and
 * tags (a mismatch names the English message). Locale files end with
 * `export default xx satisfies LocaleCheck<typeof xx>;`.
 */
export type LocaleCheck<T> = { [K in Key]: K extends keyof T ? LeafCheck<Catalog[K], T[K]> : Catalog[K] } & { [K in Exclude<keyof T, Key>]: never };
