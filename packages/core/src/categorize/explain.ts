import { featureKey, fnv1a, type Intent, type ThreadFeatures } from "./features";
import type { CategorizerModel } from "./model";

const INTENT_TEXT: Record<Intent, string> = {
  amount: "incluye un importe",
  invoice: "parece una factura o un recibo",
  tracking: "trae un número de guía",
  unsubscribe: "es un boletín",
  calendar: "es una invitación de calendario",
  otp: "trae un código de verificación",
  travel: "habla de un viaje",
  replied: "respondiste en esta conversación",
  pdf: "trae un PDF",
  bulk: "es correo masivo",
  consumer: "viene de un correo personal",
};

const conv = (n: number) => `${n} ${n === 1 ? "conversación" : "conversaciones"}`;

/**
 * Human reasons for a prediction, strongest first. Explanations re-tokenize
 * the thread (features are stored hashed), so no vocabulary table is needed.
 */
export function explain(model: CategorizerModel, f: ThreadFeatures, categoryId: number, categoryName: string, senderLabel: string): string[] {
  const reasons: string[] = [];
  const stat = (key: string) => {
    const h = fnv1a(key);
    return { ...model.featureStats(h, categoryId), positives: model.positiveCount(h, categoryId) };
  };

  const identities: [string, string][] = [[featureKey.sender(f.sender), "sender"]];
  if (f.list) identities.push([featureKey.list(f.list), "list"]);
  if (f.domain) identities.push([featureKey.domain(f.domain), "domain"]);
  let counter: string | null = null;
  for (const [key, kind] of identities) {
    const s = stat(key);
    if (s.support < 3) continue;
    if (s.llr > 0.5 && s.positives > 0) {
      const what = kind === "sender" ? "mismo remitente" : kind === "list" ? "misma lista" : `mismo dominio (@${f.domain})`;
      reasons.push(`${what} que ${conv(Math.round(s.positives))} en ${categoryName}`);
    } else if (s.llr < -1) {
      counter = `pero ${kind === "domain" ? `@${f.domain}` : senderLabel} también envía correos que no guardas aquí`;
    }
    break;
  }
  if (reasons.length === 0 && model.support(fnv1a(featureKey.sender(f.sender))) < 3) reasons.push("remitente nuevo");

  const words = f.tokens
    .map((t) => ({ t, ...stat(t) }))
    .filter((x) => x.support >= 2 && x.llr > 1 && !x.t.slice(2).startsWith("#"))
    .sort((a, b) => b.llr - a.llr || a.t.localeCompare(b.t));
  const shown = [...new Set(words.map((w) => w.t.slice(2)))].slice(0, 3);
  if (shown.length) reasons.push(`menciona ${shown.map((w) => `«${w}»`).join(", ")}`);

  for (const intent of f.intents) {
    const s = stat(featureKey.intent(intent));
    if (s.support >= 2 && s.llr > 0.7) reasons.push(INTENT_TEXT[intent]);
  }
  if (counter) reasons.push(counter);
  return reasons;
}
