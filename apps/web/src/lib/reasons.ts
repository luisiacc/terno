import type { Reason } from "@terno/core";
import { hasKey, t, type TextKey } from "@terno/i18n";

type AnyT = (key: TextKey, params?: Readonly<Record<string, string | number>>) => string;

/**
 * A categorization reason in the active language. Descriptors render through
 * the catalog; a string is a reason stored before reasons were localized (or
 * a key this build doesn't know) and shows as it is.
 */
export function reasonText(r: Reason): string {
  if (typeof r === "string") return r;
  return hasKey(r.k) ? (t as AnyT)(r.k, r.p) : r.k;
}
