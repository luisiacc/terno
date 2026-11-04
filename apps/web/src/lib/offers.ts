/**
 * Plan 91: what every action offers next, the same everywhere (the category
 * snackbar, the similar snackbar, the thread menu's submenus): one order,
 * one set of labels, one way to chain undos.
 */
import type { SimilarOffer, SimilarScope } from "@terno/core";
import { registerUndo, runUndo, useSnack, type Undo } from "~/lib/snack";

/** Narrowest first: the same sender and subject, everything from them, their domain, their list. */
export const OFFER_ORDER = ["subject", "sender", "domain", "list"] as const satisfies readonly SimilarScope["kind"][];

export function orderOffers<T extends { scope: SimilarScope }>(offers: readonly T[]): T[] {
  return [...offers].sort((a, b) => OFFER_ORDER.indexOf(a.scope.kind) - OFFER_ORDER.indexOf(b.scope.kind));
}

/**
 * The lines a filing offers, in order (plans 81, 84, 128). Each moves what's there and catches new mail, so the sender's
 * stays with nothing left now; a subject needs more of it; a domain or list holding no more than the sender is said once.
 */
export function filingOffers<T extends SimilarOffer>(offers: readonly T[]): T[] {
  const sender = offers.find((x) => x.scope.kind === "sender");
  return orderOffers(offers).filter((o) => {
    if (o.scope.kind === "sender") return true;
    if (!(o.count > 0 || o.capped)) return false;
    return o.scope.kind === "subject" || !sender || o.capped || sender.capped || o.count !== sender.count;
  });
}

/**
 * A step that runs before an earlier undo: Undo (and z) takes back the
 * newest first, then what it followed. `step` runs once (a retry after a
 * failure in `then` skips it), and `then` only if it's still waiting.
 */
export function chainUndo(step: () => Promise<unknown>, then: Undo | undefined): Undo {
  let stepped = false;
  return registerUndo(async () => {
    if (!stepped) {
      await step();
      stepped = true;
    }
    if (then?.state === "ready") await runUndo(then);
  });
}

/**
 * "No, only …": the chained step was taken back on its own; its token is
 * done, and z points at what it followed again (the action itself).
 */
export function unchain(token: Undo, back: Undo | undefined): void {
  token.state = "done";
  const s = useSnack.getState();
  if (back?.state === "ready" && (s.undo === token || s.undo === null)) useSnack.setState({ undo: back });
  else if (s.undo === token) useSnack.setState({ undo: null });
}

/** Is this undo still the one z runs (no newer action since)? */
export const isLatest = (undo: Undo): boolean => useSnack.getState().undo === undo && undo.state === "ready";
