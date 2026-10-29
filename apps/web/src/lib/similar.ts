import { similarValue, type SimilarAction, type SimilarScope } from "@terno/core";
import { t } from "@terno/i18n";
import { RpcError } from "@terno/core/rpc";
import { captureUi } from "~/lib/diag";
import { client } from "~/rpc/connection";
import { dismissSnack, registerUndo, runUndo, snack, type Undo } from "~/lib/snack";
import { setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { leaveList, trackJob, undoAction } from "~/lib/actions";

export { visibleOffers } from "./similar-offers";

/** What a scope is called, in chips, menus and results. */
export function scopeLabel(scope: SimilarScope, senderName: string | null): string {
  const name = senderName || ("email" in scope ? scope.email : "");
  switch (scope.kind) {
    case "sender":
      return t("similar.scope.sender", { name });
    case "subject":
      return t("similar.scope.subject", { name });
    case "domain":
      return t("similar.scope.domain", { domain: scope.domain });
    case "list":
      return t("similar.scope.list");
  }
}

/** The filter's name for this scope, in the user's language (the same names learned filters use). */
const filterNameOf = (scope: SimilarScope, action: SimilarAction) => t(`filters.learnedName.${action}`, { value: similarValue(scope) }).slice(0, 120);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface SimilarUndo {
  undoId: number | null;
  filterUndo: number | null;
  n: number;
  /** the sweep is back (a retry after the original's undo failed goes straight to that) */
  swept?: boolean;
}

/**
 * Takes a similar sweep back (the backend undoes the filter first), then
 * the action it followed, so one Undo restores everything the user did.
 */
async function undoSimilar(u: SimilarUndo, original: Undo | undefined): Promise<void> {
  const progress = !u.swept && u.n > 200 ? trackJob(t("actions.undoing", { count: u.n })) : null;
  try {
    if (!u.swept && (u.undoId !== null || u.filterUndo !== null)) {
      const { restored } = await client.call("similar.undo", { undoId: u.undoId, filterUndo: u.filterUndo, jobId: progress?.jobId });
      if (progress) snack.success(t("actions.undone", { count: restored }), { id: progress.snackId, duration: 4000 });
    }
    u.swept = true;
    if (original?.state === "ready") await runUndo(original);
  } finally {
    progress?.stop();
    void reloadList({ keepSelection: true });
  }
}

/** "Always" after an archive or delete: the scope as a filter for future mail. */
function always(scope: SimilarScope, action: SimilarAction): void {
  void client.call("similar.always", { scope, action, filterName: filterNameOf(scope, action) }).then(
    () => void snack.success(t("category.filterCreated"), { action: { label: t("common.edit"), name: t("category.editFilter"), onClick: () => setApp({ dialog: "filters" }) } }),
    (e: unknown) => void snack.error(t("category.filterFailed", { error: errorText(e) })),
  );
}

/**
 * Archives, deletes or spams a similar scope on the backend (sliced, with
 * progress), plus `threadIds` that are still in place. Spam also catches
 * future mail. One Undo takes back the sweep, the filter and `original`
 * (the action the snackbar's chip followed).
 */
export async function applySimilar(action: SimilarAction, threadIds: readonly number[], scope: SimilarScope, o: { senderName: string | null; original?: Undo }): Promise<void> {
  const label = scopeLabel(scope, o.senderName);
  const progress = trackJob(t(`similar.doing.${action}`));
  // z before the answer: the undo waits for what the sweep did, then takes it back (as act's does)
  let settle!: (u: SimilarUndo) => void;
  const outcome = new Promise<SimilarUndo>((r) => (settle = r));
  const undo = registerUndo(() => outcome.then((u) => undoSimilar(u, o.original)));
  try {
    const r = await client.call("similar.apply", { threadIds: [...threadIds], scope, action, jobId: progress.jobId, filterName: action === "spam" ? filterNameOf(scope, action) : undefined });
    settle({ undoId: r.undoId, filterUndo: r.filter?.filterUndo ?? null, n: r.affected });
    // undone meanwhile: its own snacks say so
    if (undo.state !== "ready") return void dismissSnack(progress.snackId);
    const notes = [r.skipped > 0 ? t("similar.skipped", { count: r.skipped }) : null, action === "spam" ? t(r.filterFailed ? "similar.filterFailed" : "similar.future") : null].filter((n): n is string => n !== null);
    const undoable = r.undoId !== null || r.filter?.filterUndo != null || o.original?.state === "ready";
    snack[r.filterFailed ? "warning" : "success"](t(`similar.done.${action}`, { count: r.affected, scope: label }), {
      id: progress.snackId,
      duration: 10_000,
      description: notes.join(" ") || undefined,
      action: undoable ? { ...undoAction(undo, t("similar.undoName")) } : undefined,
      secondary: action === "spam" ? undefined : { label: t("similar.always"), name: t("similar.alwaysName"), onClick: () => always(scope, action) },
    });
  } catch (error) {
    // the slices that committed come back with an undo
    const undoId = error instanceof RpcError ? (error.details as { undoId?: number } | undefined)?.undoId ?? null : null;
    settle({ undoId, filterUndo: null, n: 0 });
    captureUi(error, { code: "action.failed", fields: { action, count: threadIds.length } });
    snack.error(t("similar.failed", { error: errorText(error) }), { id: progress.snackId, action: undoId !== null || o.original?.state === "ready" ? undoAction(undo, t("similar.undoName")) : undefined });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

/** From the menu: the targets leave the list as an action would take them (view-aware), then the sweep runs. */
export function actSimilar(action: SimilarAction, ids: number[], scope: SimilarScope, senderName: string | null): Promise<void> {
  leaveList(action, ids);
  return applySimilar(action, ids, scope, { senderName });
}
