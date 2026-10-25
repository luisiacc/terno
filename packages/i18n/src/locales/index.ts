import type { Messages } from "../types";
import en from "./en";

/**
 * The languages Terno ships. Adding one: write `xx.ts` (copy `es.ts`; the
 * type check lists what is missing) and add its line here. `name` is the
 * language's own name (never translated); `tag` is the BCP 47 locale for
 * numbers, lists and plural rules. Only English is bundled: the others load
 * when chosen.
 */
export const LOCALES = {
  en: { name: "English", tag: "en-US", load: async (): Promise<Messages> => en },
  es: { name: "Español", tag: "es-MX", load: async (): Promise<Messages> => (await import("./es")).default },
} as const;

export type LocaleId = keyof typeof LOCALES;
export const LOCALE_IDS = Object.keys(LOCALES) as [LocaleId, ...LocaleId[]];
export const DEFAULT_LOCALE: LocaleId = "en";
