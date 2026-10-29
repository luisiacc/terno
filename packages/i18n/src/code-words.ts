import type { LocaleId } from "./locales/index";

/**
 * Words that announce a verification code in each language (plan 69). Mail
 * is matched against every language's words, whatever the UI's, so this stays
 * bundled while the catalogs load lazily. A new language must add its own:
 * the Record makes the type check fail until it does. Written as people do;
 * matching folds case and accents.
 */
export const CODE_WORDS: Record<LocaleId, readonly string[]> = {
  en: ["code", "passcode", "OTP"],
  es: ["código", "clave de verificación", "clave de acceso", "clave dinámica"],
};
