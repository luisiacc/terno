import { subjectTemplate, type SimilarOffer, type SimilarOffers, type SimilarScope } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { useEffect } from "react";
import { trackJob, undoAction, undoActions } from "~/lib/actions";
import type { FolderDrop } from "~/lib/folder-move";
import { chainUndo, orderOffers } from "~/lib/offers";
import { scopeLabel, shownCount, visibleOffers } from "~/lib/similar";
import { dismissSnack, growSnack, snack, undoNow, useSnack, zHolds, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { snackbarControls } from "./category-snackbar";
import { OfferLine } from "./offer-lines";
import { SnackClose, SnackPill } from "./snack-dock";

interface Shown {
  to: FolderDrop;
  /** the folder the drop left (a line's mail leaves it too) */
  from: string | null;
  targets: readonly number[];
  offers: SimilarOffers;
  undo: Undo;
  undoName: string;
  /** "Stays in the Inbox: …" */
  note?: string;
}

/**
 * Plan 127: the plain "Moved to Recibos · Undo" snack grows, in place, the offers for the rest: the same lines and
 * order as every other action's (plan 91). They're one-time: no filter can move mail to a folder yet. Nothing worth
 * offering leaves the snack as it is.
 */
export function showFolderSnackbar(snackId: string, shown: Shown): void {
  // an archive's rule: only what has more to do now
  if (shown.undo.state !== "ready" || visibleOffers("archive", shown.offers.offers).length === 0) return;
  growSnack(snackId, () => <FolderSnackbar id={snackId} {...shown} />);
}

/** Moves a whole scope, with progress; one Undo takes back this, then the drop it followed. */
async function applyFolderScope(to: FolderDrop, from: string | null, scope: SimilarScope, senderName: string | null, original: Undo | undefined): Promise<void> {
  const progress = trackJob(t("folder.move.moving", { folder: to.name }));
  let settle!: (u: { undoId: number | null; n: number }) => void;
  const outcome = new Promise<{ undoId: number | null; n: number }>((r) => (settle = r));
  const undo = chainUndo(() => outcome.then((u) => (u.undoId === null ? undefined : undoActions([u.undoId], u.n))), original);
  try {
    const r = await client.call("folders.moveScope", { accountId: to.accountId, folder: to.key, from, scope, jobId: progress.jobId });
    settle({ undoId: r.undoId, n: r.affected });
    if (undo.state !== "ready") return void dismissSnack(progress.snackId);
    snack.success(t("folder.move.scopeDone", { count: r.affected, folder: to.name, scope: scopeLabel(scope, senderName) }), {
      id: progress.snackId,
      duration: 10_000,
      description: r.kept > 0 ? t("folder.move.keptMany", { count: r.kept }) : undefined,
      action: undoAction(undo, t("similar.undoName")),
    });
  } catch (error) {
    // the slices that committed come back with an undo
    const undoId = error instanceof RpcError ? ((error.details as { undoId?: number } | undefined)?.undoId ?? null) : null;
    settle({ undoId, n: 0 });
    snack.error(t("folder.move.failed", { folder: to.name, error: error instanceof Error ? error.message : String(error) }), { id: progress.snackId, action: undo.state === "ready" && (undoId !== null || original?.state === "ready") ? undoAction(undo, t("similar.undoName")) : undefined });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

function FolderSnackbar({ id, to, from, targets, offers, undo, undoName, note }: Shown & { id: string }) {
  const live = useSnack((s) => s.current?.id === id);
  const z = useSnack((s) => zHolds(s, undo));
  const close = () => dismissSnack(id);
  const lines = orderOffers(visibleOffers("archive", offers.offers));
  const title = t("folder.move.done", { count: targets.length, folder: to.name });
  const run = (offer: SimilarOffer | undefined) => {
    if (!offer) return;
    close();
    void applyFolderScope(to, from, offer.scope, offers.senderName, undo.state === "ready" ? undo : undefined);
  };
  const doUndo = () => {
    close();
    undoNow(undo);
  };

  useEffect(() => {
    if (!live) return;
    snackbarControls.current = { action: (n) => run(lines[n - 1]), undo: doUndo, close };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  return (
    <div data-testid="folder-snackbar">
      <div className="flex min-h-9 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <p className="line-clamp-2 min-w-0 flex-1 text-sm" data-testid="snack-message" title={title}>
          {title}
        </p>
        {undo.state === "ready" && <SnackPill testId="snack-action" label={t("common.undo")} name={undoName} shortcut={z ? "z" : undefined} onClick={doUndo} />}
        <SnackClose onClick={close} />
      </div>
      {note && (
        <p data-testid="folder-kept" className="-mt-1.5 truncate pr-3 pb-1 pl-3 text-2xs text-muted-foreground">
          {note}
        </p>
      )}
      <div data-testid="folder-offers" className="flex flex-col px-1.5 pb-1.5">
        {lines.map((o, i) => (
          <OfferLine
            key={o.scope.kind}
            n={i + 1}
            testId={`folder-${o.scope.kind}`}
            label={scopeLabel(o.scope, offers.senderName)}
            detail={o.scope.kind === "subject" ? subjectTemplate(o.scope.subject) : undefined}
            help={t("folder.move.help", { scope: scopeLabel(o.scope, offers.senderName), folder: to.name })}
            count={shownCount(o)}
            onClick={() => run(o)}
          />
        ))}
      </div>
    </div>
  );
}
