import { savesRuleOnly, type ActionPreviewInfo, type AiActionApplied, type AiActionEvent, type AiActionStart } from "@terno/core";
import { t } from "@terno/i18n";
import { enterPreview, leavePreview, rowsToggled, useActionPreview, useActionRows } from "~/state/action-preview";
import { getApp } from "~/state/app";
import { client } from "~/rpc/connection";
import { reloadList } from "~/state/list";
import { deferred, trackJob, undoAction } from "./actions";
import { localized } from "./i18n";
import { registerUndo, snack } from "./snack";
import { installFocusIntent } from "./focus-intent";
import { sendersInSentence } from "./rule-words";

export { useActionPreview };

/** where the rule looks: the Inbox, or all mail but Spam and Trash */
export const inboxOnly = (p: Pick<ActionPreviewInfo, "plan">): boolean => p.plan.lookIn === "inbox" || p.plan.action.type === "archive";

export const verbOf = (p: Pick<ActionPreviewInfo, "plan">) => (p.plan.action.type === "createCategory" ? "moveToCategory" : p.plan.action.type);

/**
 * Plan 161, pass 3: the verbs that take mail out of view where a later look won't find it (Trash, Spam). Their Apply is
 * BoardUI's destructive button, and their preview always says what happens.
 */
export const isDestructive = (p: Pick<ActionPreviewInfo, "plan">): boolean => p.plan.action.type === "trash" || p.plan.action.type === "spam";

/** At this many, any verb says what it will do in words, under the request. */
export const LARGE_BATCH = 100;

/**
 * Plan 161, pass 3: a large or destructive batch, said plainly: what happens to how many, and from where ("838
 * conversations go to Trash, from all your mail except Spam and Trash."). Null for a small, harmless one, a rule that
 * only saves, and while no count is final.
 */
export function previewConsequence(preview: ActionPreviewInfo, folderName: string): { text: string; destructive: boolean } | null {
  if (savesRuleOnly(preview) || preview.scanning || preview.count === 0) return null;
  const destructive = isDestructive(preview);
  if (!destructive && preview.count < LARGE_BATCH) return null;
  const where = t(inboxOnly(preview) ? "action.where.inbox" : "action.where.everywhere");
  return { text: t(`action.consequence.${verbOf(preview)}`, { count: preview.count, where, category: preview.categoryName ?? "", folder: folderName }), destructive };
}

/**
 * Plan 161: no count is said until it's final: "Finding… 4 so far" over the 4 rows there are, then the one number the
 * title, the button and the snack all use. The header and the reader say it alike.
 */
export function previewTitle(preview: ActionPreviewInfo, shown: number, folderName: string): string {
  if (savesRuleOnly(preview)) return preview.plan.summary;
  if (preview.scanning) return shown > 0 ? t("action.findingSoFar", { count: shown }) : t("action.finding");
  return t(`action.title.${verbOf(preview)}`, { count: preview.count, category: preview.categoryName ?? "", folder: folderName });
}

/**
 * Plan 161, pass 2: Split's list header, too narrow at 1100 px for the outcome beside its buttons: only the count (the
 * verb is the button's, the outcome the reader's title). The same wait for a final number as `previewTitle`.
 */
export function previewCount(preview: ActionPreviewInfo, shown: number): string {
  if (savesRuleOnly(preview) || preview.scanning) return previewTitle(preview, shown, "");
  return t("action.count", { count: preview.count });
}

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
    if (!s.checking && !s.checkError) void check({});
  }
}

rowsToggled.current = (preview) => {
  if (getApp().actionPreview === preview.previewId) useActionPreview.setState({ preview });
};

let lastRows = 0;
/** what the backend said before its own answer got here: a short walk can be over by then */
let early: AiActionEvent | null = null;
export function installActionPreview(): void {
  installFocusIntent();
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
  useActionPreview.setState({ preview, sentence: sentence.trim(), future: (preview.plan.future || preview.plan.action.type === "spam") && preview.keep.kind === "ok", checking: false, checkError: null, applying: false, senders: null });
  void noteSenders(preview.previewId, sentence);
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

/**
 * Plan 161 (the owner): the senders the sentence names, without a model: its addresses and domains at once, and a name
 * after "from" or "de" once the mailbox is asked whether someone by it has written. One request, after the preview opens
 * and off its rows; a failure or a cold index names nobody.
 */
async function noteSenders(previewId: string, sentence: string): Promise<void> {
  const { sure, phrases } = sendersInSentence(sentence);
  const still = () => getApp().actionPreview === previewId && useActionPreview.getState().preview?.previewId === previewId;
  if (!phrases.length) {
    if (sure.length) useActionPreview.setState({ senders: { sure, names: [] } });
    return;
  }
  const names = await client.call("senders.named", { phrases }).then((r) => r.named, () => [] as string[]);
  if (still()) useActionPreview.setState({ senders: { sure, names } });
}

export async function check(o: { skip?: boolean }): Promise<void> {
  const { preview } = useActionPreview.getState();
  if (!preview) return;
  useActionPreview.setState({ checking: !o.skip, checkError: null });
  try {
    const r = await client.call("ai.actionCheck", { previewId: preview.previewId, requestId: globalThis.crypto.randomUUID(), ...o });
    if (getApp().actionPreview !== preview.previewId) return;
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
    // plan 162: the result says what it was for: the request in its words under the count (it read as any archive's)
    const asked = s.sentence ? t("action.asked", { sentence: s.sentence }) : null;
    // what happened first (a partial apply, what changed or was spared, the rule), then what was asked
    const description = [ruleOnly ? undefined : notes(r), asked].filter(Boolean).join(" ") || undefined;
    snack.success(r.stopped ? t("action.outcome.stopped", { outcome: message }) : message, { id: job.snackId, duration: 8000, description, action: r.undoToken !== null ? undoAction(undo, t("action.undoName", { outcome: message })) : undefined });
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
