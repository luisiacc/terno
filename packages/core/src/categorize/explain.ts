import type { ParamsArg, TextKey } from "@terno/i18n";
import type { Reason } from "../types";
import { featureKey, fnv1a, type Intent, type ThreadFeatures } from "./features";
import type { CategorizerModel } from "./model";

const INTENT_KEY = {
  amount: "reason.intent.amount",
  invoice: "reason.intent.invoice",
  tracking: "reason.intent.tracking",
  unsubscribe: "reason.intent.unsubscribe",
  calendar: "reason.intent.calendar",
  otp: "reason.intent.otp",
  travel: "reason.intent.travel",
  replied: "reason.intent.replied",
  pdf: "reason.intent.pdf",
  bulk: "reason.intent.bulk",
  consumer: "reason.intent.consumer",
} as const satisfies Record<Intent, TextKey>;

const IDENTITY_KEY = { sender: "reason.sameSender", list: "reason.sameList", domain: "reason.sameDomain" } as const;

/** A reason as a catalog descriptor: persisted as is, rendered in the reader's language. */
export function reason<K extends TextKey>(k: K, ...args: ParamsArg<K>): Reason {
  const p = args[0] as Record<string, string | number> | undefined;
  return p ? { k, p } : { k };
}

/**
 * Human reasons for a prediction, strongest first. Explanations re-tokenize
 * the thread (features are stored hashed), so no vocabulary table is needed.
 */
export function explain(model: CategorizerModel, f: ThreadFeatures, categoryId: number, categoryName: string, senderLabel: string): Reason[] {
  const reasons: Reason[] = [];
  const stat = (key: string) => {
    const h = fnv1a(key);
    return { ...model.featureStats(h, categoryId), positives: model.positiveCount(h, categoryId) };
  };

  const identities: [string, keyof typeof IDENTITY_KEY][] = [[featureKey.sender(f.sender), "sender"]];
  if (f.list) identities.push([featureKey.list(f.list), "list"]);
  if (f.domain) identities.push([featureKey.domain(f.domain), "domain"]);
  let counter: Reason | null = null;
  for (const [key, kind] of identities) {
    const s = stat(key);
    if (s.support < 3) continue;
    if (s.llr > 0.5 && s.positives > 0) {
      const count = Math.round(s.positives);
      reasons.push(kind === "domain" ? reason(IDENTITY_KEY.domain, { count, category: categoryName, domain: f.domain! }) : reason(IDENTITY_KEY[kind], { count, category: categoryName }));
    } else if (s.llr < -1) {
      counter = reason("reason.alsoElsewhere", { sender: kind === "domain" ? `@${f.domain}` : senderLabel });
    }
    break;
  }
  if (reasons.length === 0 && model.support(fnv1a(featureKey.sender(f.sender))) < 3) reasons.push(reason("reason.newSender"));

  const words = f.tokens
    .map((t) => ({ t, ...stat(t) }))
    .filter((x) => x.support >= 2 && x.llr > 1 && !x.t.slice(2).startsWith("#"))
    .sort((a, b) => b.llr - a.llr || a.t.localeCompare(b.t));
  const shown = [...new Set(words.map((w) => w.t.slice(2)))].slice(0, 3);
  if (shown.length) reasons.push(reason("reason.mentions", { count: shown.length, a: shown[0]!, b: shown[1] ?? "", c: shown[2] ?? "" }));

  for (const intent of f.intents) {
    const s = stat(featureKey.intent(intent));
    if (s.support >= 2 && s.llr > 0.7) reasons.push(reason(INTENT_KEY[intent]));
  }
  if (counter) reasons.push(counter);
  return reasons;
}

const isParams = (p: unknown): p is Record<string, string | number> =>
  typeof p === "object" && p !== null && !Array.isArray(p) && Object.values(p).every((v) => typeof v === "string" || typeof v === "number");

/**
 * Reasons as stored (explain_json): descriptors, or the strings persisted
 * before reasons were localized. Anything else is dropped, never trusted.
 */
export function parseReasons(json: string | null | undefined): Reason[] {
  let value: unknown;
  try {
    value = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((r: unknown): Reason[] => {
    if (typeof r === "string") return [r];
    if (typeof r !== "object" || r === null) return [];
    const { k, p } = r as { k?: unknown; p?: unknown };
    if (typeof k !== "string") return [];
    if (p === undefined) return [{ k: k as TextKey }];
    return isParams(p) ? [{ k: k as TextKey, p }] : [];
  });
}
