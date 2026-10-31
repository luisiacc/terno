import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { snack } from "~/lib/snack";
import { trackJob } from "~/lib/actions";
import { reloadList } from "~/state/list";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Plan 89: a filter applied to existing mail runs in the background, owned
 * here rather than by the dialog (closing it keeps it going): a progress
 * snack that ends with how many conversations it changed, or, when it fails
 * partway, how many it changed before that.
 */
export async function applyFilter(id: number, name: string): Promise<void> {
  const progress = trackJob(t("filters.applying", { name }));
  try {
    const r = await client.call("filters.apply", { id, jobId: progress.jobId });
    snack.success(t("filters.applied", { count: r.affectedThreads }), { id: progress.snackId, duration: 6000 });
  } catch (error) {
    const done = (error as { details?: { affectedThreads?: unknown } }).details?.affectedThreads;
    const message = typeof done === "number" && done > 0 ? t("filters.applyPartial", { count: done, error: errorText(error) }) : t("filters.applyFailed", { error: errorText(error) });
    snack.error(message, { id: progress.snackId });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}
