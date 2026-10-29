import type { SimilarAction, SimilarOffer, SimilarOffers } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect } from "react";
import { said } from "~/lib/actions";
import { applySimilar, scopeLabel, visibleOffers } from "~/lib/similar";
import { dismissSnack, snack, undoNow, useSnack, zHolds, type Undo } from "~/lib/snack";
import { setApp } from "~/state/app";
import { Chip, snackbarControls, Strip } from "./category-snackbar";
import { SnackClose, SnackPill } from "./snack-dock";

const LIFETIME_MS = 10_000;

interface Shown {
  action: SimilarAction;
  /** how many the action itself moved */
  count: number;
  offers: SimilarOffers;
  undo: Undo;
}

/**
 * Plan 63: the plain "Archived · Undo" snack grows chips for the rest from
 * the same sender, subject, domain or list (in place: same id, no new
 * entry). Nothing worth offering leaves it as it is.
 */
export function showSimilarSnackbar(snackId: string, shown: Shown): void {
  const s = useSnack.getState();
  // replaced, closed, or undone meanwhile: nothing to grow
  if (s.current?.id !== snackId || shown.undo.state !== "ready") return;
  if (visibleOffers(shown.action, shown.offers.offers).length === 0) return;
  snack.custom({ id: snackId, message: said(shown.action, shown.count), duration: LIFETIME_MS, render: () => <SimilarSnackbar id={snackId} {...shown} /> });
}

function SimilarSnackbar({ id, action, count, offers, undo }: Shown & { id: string }) {
  const z = useSnack((s) => zHolds(s, undo));
  const live = useSnack((s) => s.current?.id === id);
  const chips = visibleOffers(action, offers.offers);
  const title = said(action, count);
  const close = () => dismissSnack(id);
  const run = (offer: SimilarOffer | undefined) => {
    if (!offer) return;
    close();
    // the chip takes over the action's undo: one Undo brings back both
    void applySimilar(action, [], offer.scope, { senderName: offers.senderName, original: undo });
  };
  const doUndo = () => {
    close();
    undoNow(undo);
  };

  useEffect(() => {
    if (!live) return;
    snackbarControls.current = { action: (n) => run(chips[n - 1]), undo: doUndo, close };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  return (
    <div data-testid="similar-snackbar">
      <div className="flex min-h-9 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <p className="min-w-0 flex-1 truncate text-sm" data-testid="snack-message" title={title}>
          {title}
        </p>
        {undo.state === "ready" && <SnackPill testId="snack-action" label={t("common.undo")} name={t("snack.undoName", { message: title })} shortcut={z ? "z" : undefined} onClick={doUndo} />}
        <SnackClose onClick={close} />
      </div>
      <Strip>
        {action === "spam" && (
          <span data-testid="similar-future" className="shrink-0 text-2xs text-muted-foreground">
            {t("similar.alsoFuture")}
          </span>
        )}
        {chips.map((o, i) => (
          <Chip
            key={o.scope.kind}
            n={i + 1}
            testId={`similar-${o.scope.kind}`}
            label={scopeLabel(o.scope, offers.senderName)}
            title={o.scope.kind === "subject" ? o.scope.subject : undefined}
            count={action === "spam" && o.count === 0 ? undefined : o}
            onClick={() => run(o)}
          />
        ))}
      </Strip>
    </div>
  );
}
