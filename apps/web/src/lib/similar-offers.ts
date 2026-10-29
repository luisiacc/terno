import type { SimilarAction, SimilarOffer } from "@terno/core";

/**
 * The chips worth showing. Archive and Delete: only scopes with more to do
 * now, and a wider one only when it holds more than the sender. Spam: every
 * scope, since each also catches future mail.
 */
export function visibleOffers(action: SimilarAction, offers: readonly SimilarOffer[]): SimilarOffer[] {
  if (action === "spam") return [...offers];
  const sender = offers.find((o) => o.scope.kind === "sender");
  const same = (o: SimilarOffer) => !!sender && o !== sender && o.count === sender.count && o.capped === sender.capped;
  return offers.filter((o) => o.count > 0 && !same(o));
}
