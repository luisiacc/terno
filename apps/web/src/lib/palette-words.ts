import { DEFAULT_LOCALE, getLocale, L, type ParamsArg, type TextKey } from "@terno/i18n";

/**
 * More words the palette's filter (cmdk `keywords`) matches an item by: in
 * another language, the English ones too, so typing English always works.
 */
export function englishWords<K extends TextKey>(key: K, ...args: ParamsArg<K>): string[] {
  return getLocale() === DEFAULT_LOCALE ? [] : [L(key, ...args).message];
}
