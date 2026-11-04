import { subjectTemplate, type SimilarOffer, type SimilarOffers, type SimilarScope } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { useEffect } from "react";
import { trackJob, undoAction, undoActions } from "~/lib/actions";
import type { FolderDrop } from "~/lib/folder-move";
import { filterNameOf } from "~/lib/categorize";
import { chainUndo, filingOffers } from "~/lib/offers";
import { scopeLabel } from "~/lib/similar";
import { dismissSnack, growSnack, snack, undoNow, useSnack, zHolds, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
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
 * order as a category's (plan 91). Plan 128: each moves what's there and catches new mail, so the sender's line stays
 * with nothing left to move now.
 */
export function showFolderSnackbar(snackId: string, shown: Shown): void {
  if (shown.undo.state !== "ready" || filingOffers(shown.offers.offers).length === 0) return;
  growSnack(snackId, () => <FolderSnackbar id={snackId} {...shown} />);
}

const folderName = (to: FolderDrop, key: string) => getApp().folders.find((f) => f.accountId === to.accountId && f.key === key)?.path.at(-1) ?? key;

/** Moves a whole scope, with progress, and files its new mail; one Undo takes back the filter, this, then the drop it followed. */
export async function applyFolderScope(to: FolderDrop, from: string | null, scope: SimilarScope, senderName: string | null, original: Undo | undefined): Promise<void> {
  const progress = trackJob(t("folder.move.moving", { folder: to.name }));
  interface Done {
    undoId: number | null;
    filterUndo: number | null;
    n: number;
  }
  let settle!: (u: Done) => void;
  const outcome = new Promise<Done>((r) => (settle = r));
  const undo = chainUndo(async () => {
    const u = await outcome;
    // the filter first: no new mail is caught while the threads come back
    if (u.filterUndo !== null) await client.call("similar.undo", { undoId: null, filterUndo: u.filterUndo });
    if (u.undoId !== null) await undoActions([u.undoId], u.n);
  }, original);
  try {
    const label = scopeLabel(scope, senderName);
    const r = await client.call("folders.moveScope", { accountId: to.accountId, folder: to.key, from, scope, filterName: filterNameOf(scope, senderName, to.name), jobId: progress.jobId });
    settle({ undoId: r.undoId, filterUndo: r.filter?.filterUndo ?? null, n: r.affected });
    if (undo.state !== "ready") return void dismissSnack(progress.snackId);
    const notes = [
      r.kept > 0 ? t("folder.move.keptMany", { count: r.kept }) : null,
      r.filterFailed ? t("offers.default.noFilter") : r.filter?.retargeted ? t("offers.default.retargeted", { category: to.name, from: folderName(to, r.filter.retargeted.from) }) : null,
    ].flatMap((x) => x ?? []);
    // nothing left to move now: what it did is the filter
    const message = r.affected > 0 || r.filterFailed ? t("folder.move.scopeDone", { count: r.affected, folder: to.name, scope: label }) : t("folder.move.futureOnly", { folder: to.name, scope: label });
    snack[r.filterFailed ? "warning" : "success"](message, { id: progress.snackId, duration: 10_000, description: notes.join(" ") || undefined, action: undoAction(undo, t("similar.undoName")) });
  } catch (error) {
    // what committed comes back with an undo: the slices that moved, the filter saved before them
    const details = error instanceof RpcError ? (error.details as { undoId?: number | null; filterUndo?: number | null } | undefined) : undefined;
    const undoId = details?.undoId ?? null;
    const filterUndo = details?.filterUndo ?? null;
    settle({ undoId, filterUndo, n: 0 });
    snack.error(t("folder.move.failed", { folder: to.name, error: error instanceof Error ? error.message : String(error) }), { id: progress.snackId, action: undo.state === "ready" && (undoId !== null || filterUndo !== null || original?.state === "ready") ? undoAction(undo, t("similar.undoName")) : undefined });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

function FolderSnackbar({ id, to, from, targets, offers, undo, undoName, note }: Shown & { id: string }) {
  const live = useSnack((s) => s.current?.id === id);
  const z = useSnack((s) => zHolds(s, undo));
  const close = () => dismissSnack(id);
  const lines = filingOffers(offers.offers);
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
            future
            // the sender with nothing left now: the line is about their future mail, no "0"
            count={o.count === 0 && !o.capped ? undefined : o}
            onClick={() => run(o)}
          />
        ))}
      </div>
    </div>
  );
}
