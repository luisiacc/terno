import { savesRuleOnly, type ActionPreviewInfo, type AiActionApplied, type AiActionEvent, type AiActionStart } from "@terno/core";
import { t } from "@terno/i18n";
import { enterPreview, leavePreview, rowsToggled, useActionPreview, useActionRows } from "~/state/action-preview";
import { getApp } from "~/state/app";
import { client } from "~/rpc/connection";
import { reloadList } from "~/state/list";
import { deferred, trackJob, undoAction } from "./actions";
import { localized } from "./i18n";
import { registerUndo, snack } from "./snack";

export { useActionPreview };

/** where the rule looks: the Inbox, or all mail but Spam and Trash */
export const inboxOnly = (p: Pick<ActionPreviewInfo, "plan">): boolean => p.plan.lookIn === "inbox" || p.plan.action.type === "archive";

/** plan 161: waiting on the search or the check, Apply can't run yet, and no count is final */
export const previewWaiting = (p: Pick<ActionPreviewInfo, "scanning" | "check">, checking: boolean): boolean => p.scanning || p.check === "needed" || checking;

const messageOf = (error: unknown) => {
  const e = error as { message?: string; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
  return localized(e.message ?? "", e.i18n);
};

function took(preview: ActionPreviewInfo): void {
  useActionPreview.setState({ preview });
  if (!preview.scanning && preview.check === "needed") {
    const s = useActionPreview.getState();
    if (!s.checking && !s.consent && !s.checkError) void check({});
  }
}

rowsToggled.current = (preview) => {
  if (getApp().actionPreview === preview.previewId) useActionPreview.setState({ preview });
};

let lastRows = 0;
/** what the backend said before its own answer got here: a short walk can be over by then */
let early: AiActionEvent | null = null;
export function installActionPreview(): void {
  client.on("aiAction", (event) => {
    if (getApp().actionPreview !== event.previewId) {
      early = event;
      return;
    }
    if ("ended" in event) {
      leavePreview();
      snack.error(t(event.ended === "tooMany" ? "action.tooMany" : "action.failed"));
      return;
    }
    const wasScanning = useActionPreview.getState().preview?.scanning;
    took(event.preview);
    // the list follows the count: at most a few times a second, as the backend sends it, and once at the end
    if (wasScanning && (!event.preview.scanning || Date.now() - lastRows > 500)) {
      lastRows = Date.now();
      void reloadList({ keepSelection: true, window: true });
    }
  });
}

/** The page's part: what came of a sentence. The preview opens with its first rows; anything else stays on the page. */
export function opened(r: Extract<AiActionStart, { status: "preview" }>, sentence = ""): void {
  const { preview } = r;
  useActionPreview.setState({ preview, sentence: sentence.trim(), future: (preview.plan.future || preview.plan.action.type === "spam") && preview.keep.kind === "ok", checking: false, consent: null, checkError: null, applying: false });
  // plan 161: the sidebar on the place the rule looks in (archive only ever looks in the Inbox)
  enterPreview(preview.previewId, inboxOnly(preview) ? "inbox" : "all");
  const heard = early?.previewId === preview.previewId ? early : null;
  early = null;
  if (heard && "ended" in heard) {
    leavePreview();
    snack.error(t(heard.ended === "tooMany" ? "action.tooMany" : "action.failed"));
    return;
  }
  took(heard && "preview" in heard ? heard.preview : preview);
  void reloadList({ keepSelection: true, window: true });
}

export async function check(o: { acknowledge?: string; skip?: boolean }): Promise<void> {
  const { preview } = useActionPreview.getState();
  if (!preview) return;
  useActionPreview.setState({ checking: !o.skip, consent: null, checkError: null });
  try {
    const r = await client.call("ai.actionCheck", { previewId: preview.previewId, requestId: globalThis.crypto.randomUUID(), ...o });
    if (getApp().actionPreview !== preview.previewId) return;
    if (r.status === "consent") return useActionPreview.setState({ checking: false, consent: { provider: r.provider, endpoint: r.endpoint, destination: r.destination } });
    useActionPreview.setState({ checking: false, preview: r.preview, future: useActionPreview.getState().future && r.preview.keep.kind === "ok" });
    await reloadList({ keepSelection: true, window: true });
  } catch (error) {
    if (getApp().actionPreview !== preview.previewId) return;
    useActionPreview.setState({ checking: false, checkError: messageOf(error) });
  }
}

export async function includeSkipped(included: boolean): Promise<void> {
  const { preview } = useActionPreview.getState();
  if (!preview) return;
  useActionPreview.setState({ preview: await client.call("ai.actionIncludeSkipped", { previewId: preview.previewId, included }) });
  await reloadList({ keepSelection: true, window: true });
}

export function showLeftOut(show: boolean): void {
  useActionRows.setState({ showLeftOut: show });
  void reloadList({ keepSelection: true, window: true });
}

const notes = (r: AiActionApplied): string | undefined => {
  const lines = [r.failed ? t("action.partial") : null, r.changed ? t("action.changed", { count: r.changed }) : null, r.spared ? t("action.spared", { count: r.spared }) : null, r.filterSaved ? t("action.filterSaved") : null, r.filterFailed ? t("action.filterFailed") : null].filter(Boolean);
  return lines.length ? lines.join(" ") : undefined;
};

/** Apply: the only way a sentence changes anything. */
export async function applyPreview(): Promise<void> {
  const s = useActionPreview.getState();
  const { preview } = s;
  if (!preview || s.applying || preview.scanning || preview.check === "needed" || (preview.count === 0 && !savesRuleOnly(preview))) return;
  useActionPreview.setState({ applying: true });
  const verb = preview.plan.action.type === "createCategory" ? "moveToCategory" : preview.plan.action.type;
  const job = trackJob(t("action.job"));
  snack.progress(job.snackId, t("actions.job", { title: t("action.job") }));
  const ruleOnly = savesRuleOnly(preview);
  const undoToken = deferred<string | null>();
  const undo = registerUndo(async () => {
    const token = await undoToken.promise;
    if (token === null) return;
    const r = await client.call("ai.actionUndo", { token });
    // plan 161: a result, said for what it undid
    snack.success(ruleOnly ? t("action.rule.undone") : t(`action.undone.${verb}`, { count: r.restored, category: preview.categoryName ?? "" }));
    void reloadList({ keepSelection: true });
  });
  try {
    const r = await client.call("ai.actionApply", { previewId: preview.previewId, jobId: job.jobId, future: s.future });
    undoToken.resolve(r.undoToken);
    leavePreview();
    if (ruleOnly && !r.filterSaved) {
      // a category it made first is still Undo's to take back
      snack.error(t("action.rule.failed"), { id: job.snackId, action: r.undoToken !== null ? undoAction(undo, t("action.rule.failed")) : undefined });
      return;
    }
    const message = ruleOnly ? t("action.rule.saved") : t(`action.outcome.${verb}`, { count: r.done, category: preview.categoryName ?? "" });
    snack.success(r.stopped ? t("action.outcome.stopped", { outcome: message }) : message, { id: job.snackId, duration: 8000, description: ruleOnly ? undefined : notes(r), action: r.undoToken !== null ? undoAction(undo, t("action.undoName", { outcome: message })) : undefined });
  } catch (error) {
    undoToken.resolve(null);
    useActionPreview.setState({ applying: false });
    snack.error(messageOf(error), { id: job.snackId });
  } finally {
    job.stop();
    void reloadList({ keepSelection: true });
  }
}

export function stopApplying(): void {
  const { preview, applying } = useActionPreview.getState();
  if (preview && applying) void client.call("ai.actionStop", { previewId: preview.previewId }).catch(() => {});
}
