import { isLocalized, type Localized } from "@terno/i18n";

/** A catalog reference (an L() message without its English text), as it crosses to the renderer. */
export interface TextRef {
  key: string;
  params?: Readonly<Record<string, string | number>>;
}

/**
 * The catalog reference of a message (none for plain text). Error classes
 * that take `string | Localized` keep it as `i18n`, which toErrorPayload
 * sends so the renderer shows the message in the user's language.
 */
export function textRef(value: unknown): TextRef | undefined {
  if (!isLocalized(value)) return undefined;
  return value.params ? { key: value.key, params: value.params } : { key: value.key };
}

/**
 * An error's message with its catalog reference, when it carries one (an
 * error built from an L() message sets `i18n`): wrapping an error in another
 * keeps the user's language.
 */
export function messageOf(error: unknown): string | Localized {
  const message = error instanceof Error ? error.message : String(error);
  const ref = textRef((error as { i18n?: unknown } | null)?.i18n);
  return ref ? { ...ref, message } : message;
}

/**
 * Text kept in a free-text column (an op's last error or warning): a catalog
 * message is stored as JSON so it can still be shown in the user's language.
 */
export function encodeText(text: string | Localized): string {
  return typeof text === "string" ? text : JSON.stringify(text.params ? { key: text.key, params: text.params, message: text.message } : { key: text.key, message: text.message });
}

/** The other side of encodeText: the English message, plus its catalog reference when it has one. Plain text stays as it is. */
export function decodeText(stored: string): { message: string; i18n?: TextRef } {
  if (stored.startsWith('{"key":')) {
    try {
      const value: unknown = JSON.parse(stored);
      const ref = textRef(value);
      const message = (value as { message?: unknown }).message;
      if (ref && typeof message === "string") return { message, i18n: ref };
    } catch {
      // not ours: plain text that happens to start like JSON
    }
  }
  return { message: stored };
}
