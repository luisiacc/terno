import { attachmentFingerprint, exportAttachment, importAttachments, validateExportedAttachments } from "./attachments";
import { RpcError, type ExportedAttachment } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { decodeText, type Condition, type FilterAction, type FilterRule } from "@terno/core";
import { draftAddressSchema, exportCategorySchema, exportDraftSchema, exportFilterSchema, settingsPatchSchema, type ExportCategory, type ExportDraftItem, type ExportFilter, type DraftAddress, type ExportedDraft, type ExportFile, type ImportResult, type MailboxExport, type SettingsPatch } from "@terno/core/rpc";
import type { DraftInput, DraftRow } from "@terno/store";
import { GAP, textToHtmlChunks } from "@terno/richtext/quote";
import type { BackendCore as Backend } from "./core";
import { pinKeyOrigins, readSettings, SettingsError, updateSettings } from "./settings";

const GENERAL_KEYS = [
  "theme",
  "design",
  "lightTheme",
  "darkTheme",
  "previousLightTheme",
  "previousDarkTheme",
  "motionMs",
  "htmlMailAppearance",
  "customThemes",
  "density",
  "layout",
  "remoteImages",
  "gmailClientId",
  "syncWindowDays",
  "autoCategorize",
  "aiCategorize",
  "language",
] as const;

const addresses = draftAddressSchema.array().max(200);

/** The settings an export carries, as a patch: each field only if valid on its own; secrets never travel. */
function settingsFrom(raw: Record<string, unknown>, current: { localMode: boolean; allowAgentSend: boolean; errorReports: string; senderIcons: boolean }): { general: SettingsPatch; ai: SettingsPatch["ai"] } {
  const general: Record<string, unknown> = {};
  for (const key of GENERAL_KEYS) {
    if (raw[key] === undefined) continue;
    const r = settingsPatchSchema.safeParse({ [key]: raw[key] });
    if (r.success) general[key] = (r.data as Record<string, unknown>)[key];
  }
  // plan 15: a file from before designs carries the palettes then chosen: like this install's own, they become "previous", and Lumen applies
  if (raw.design === undefined) {
    for (const [from, to] of [["lightTheme", "previousLightTheme"], ["darkTheme", "previousDarkTheme"]] as const) {
      if (general[from] !== undefined) general[to] = general[from] === "design" ? null : general[from];
      delete general[from];
    }
  }
  // a file never makes this install less private: local mode can come on, agent sending can go off
  if (raw.localMode === true && !current.localMode) general.localMode = true;
  if (raw.allowAgentSend === false && current.allowAgentSend) general.allowAgentSend = false;
  if (raw.errorReports === "never" && current.errorReports !== "never") general.errorReports = "never";
  // plan 22: website icons can go off, never on
  if (raw.senderIcons === false && current.senderIcons) general.senderIcons = false;
  const ai = raw.ai as { provider?: unknown; model?: unknown; baseURL?: unknown; preset?: unknown } | undefined;
  const parsed = ai ? settingsPatchSchema.safeParse({ ai: { provider: ai.provider, model: ai.model, baseURL: ai.baseURL ?? null, preset: ai.preset ?? null } }) : null;
  return { general: general as SettingsPatch, ai: parsed?.success ? parsed.data.ai : undefined };
}

/** What can't be re-synced, as a file (format 2): drafts whole, what they answer or forward by Message-ID. */
export async function exportMailbox(b: Backend): Promise<MailboxExport> {
  const store = b.store;
  const accounts = await store.accounts.list();
  const emailOf = (id: number) => accounts.find((a) => a.id === id)?.email ?? null;
  const ref = (id: number | null) => (id === null ? Promise.resolve(null) : store.drafts.messageRef(id));
  const drafts: ExportedDraft[] = [];
  let attachmentBytes = 0;
  const exportParts = async (accountId: number, refs: import("@terno/core").AttachmentRef[]) => {
    const parts: ExportedAttachment[] = [];
    for (const ref of refs) {
      attachmentBytes += ref.size;
      if (attachmentBytes > 32 * 1024 * 1024) throw new RpcError("BAD_REQUEST", L("attachments.backupTooLarge"));
      parts.push(await exportAttachment(store, accountId, ref, () => b.yieldTurn()));
    }
    return parts;
  };
  for (const d of await store.drafts.list()) {
    drafts.push({
      accountEmail: emailOf(d.account_id),
      mode: d.mode,
      to: JSON.parse(d.to_json) as DraftAddress[],
      cc: JSON.parse(d.cc_json) as DraftAddress[],
      bcc: JSON.parse(d.bcc_json) as DraftAddress[],
      subject: d.subject,
      subjectEdited: d.subject_edited === 1,
      bodyText: d.body_text,
      bodyHtml: d.body_html,
      attachments: await exportParts(d.account_id, JSON.parse(d.attachments_json ?? "[]")),
      quotedText: d.quoted_text,
      includeQuote: d.include_quote === 1,
      inReplyTo: await ref(d.in_reply_to_message_id),
      forwardOf: await ref(d.forward_of_message_id),
      uiState: d.ui_state,
      updatedAt: d.updated_at,
    });
  }
  const ops: MailboxExport["ops"] = [];
  for (const o of await store.ops.recent(100_000)) {
    if (o.state === "succeeded") continue;
    const payload = JSON.parse(o.payload_json);
    if (o.kind === "send" && payload.attachments?.length) payload.attachments = await exportParts(o.account_id, payload.attachments);
    ops.push({ accountEmail: emailOf(o.account_id), kind: o.kind, state: o.state, createdAt: o.created_at, lastError: o.last_error === null ? null : decodeText(o.last_error).message, target: JSON.parse(o.target_json), payload });
    await b.yieldTurn();
  }
  return {
    format: "terno-export",
    version: 2,
    exportedAt: b.now(),
    app: b.options.version,
    accounts: accounts.map((a) => ({ id: a.id, email: a.email, kind: a.kind, displayName: a.displayName })),
    categories: await store.categories.list(),
    filters: await store.filters.list(),
    settings: await readSettings(store),
    drafts,
    ops,
  };
}

type ExportDraft = ExportDraftItem;
/** A filter whose account conditions wait for their mailboxes: the old ids and the addresses they meant. */
interface PendingFilter {
  name: string;
  enabled: boolean;
  source: "manual" | "ai" | "learned";
  rule: FilterRule;
  accountEmails: Record<string, string>;
}
interface Pending {
  drafts: ExportDraft[];
  filters: PendingFilter[];
}
const PENDING = "import:pending";
const emptyPending: Pending = { drafts: [], filters: [] };
const pendingOf = (store: Backend["store"]) => store.settings.get<Pending>(PENDING, emptyPending);
const savePending = (store: Backend["store"], p: Pending) => store.settings.set(PENDING, p);
/** Both lists, each item once. */
function mergePending(a: Pending, b: Pending): Pending {
  const uniq = <T,>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
  return { drafts: uniq([...a.drafts, ...b.drafts]), filters: uniq([...a.filters, ...b.filters]) };
}

/**
 * Puts in what has its mailbox here: filters whose every account condition
 * names a connected address (remapped to it), drafts of connected mailboxes.
 * A reply or forward whose original hasn't synced yet waits, unless `final`
 * for its account (its first sync is done): then it comes in as a new message.
 * Returns what still waits.
 */
async function attachmentKeys(b: Backend, accountId: number, refs: import("@terno/core").AttachmentRef[]): Promise<unknown[]> {
  const keys = [];
  for (const ref of refs) keys.push([ref.filename, ref.mime, ref.size, ref.contentId ?? null, await attachmentFingerprint(b.store, accountId, ref, () => b.yieldTurn())]);
  return keys;
}

async function restoreInto(b: Backend, items: Pending, options: { final: boolean | number }): Promise<{ filters: number; existingFilters: number; drafts: number; left: Pending }> {
  const store = b.store;
  const now = b.now();
  const accounts = await store.accounts.list();
  const idOf = (email: string) => accounts.find((a) => a.email === email.toLowerCase())?.id;
  const left: Pending = { drafts: [], filters: [] };
  const same = new Set((await store.filters.list()).map((f) => `${f.name}\n${JSON.stringify(f.rule)}`));
  let filters = 0;
  let existingFilters = 0;
  // in time slices: thousands of filters or drafts must not hold the event loop (interactive RPCs keep flowing)
  await b.runSliced(items.filters, 50, async (chunk) => {
    for (const f of chunk) {
      const ids = Object.fromEntries(Object.entries(f.accountEmails).map(([old, email]) => [old, idOf(email)]));
      if (Object.values(ids).some((id) => id === undefined)) {
        left.filters.push(f);
        continue;
      }
      const conditions = f.rule.conditions.map((c): Condition => (c.field === "account" ? { ...c, value: ids[String(c.value)]! } : c));
      const rule: FilterRule = { ...f.rule, conditions };
      const key = `${f.name}\n${JSON.stringify(rule)}`;
      if (same.has(key)) {
        existingFilters++;
        continue;
      }
      same.add(key);
      await store.filters.save({ name: f.name, enabled: f.enabled, source: f.source, rule }, now);
      filters++;
    }
  });
  let drafts = 0;
  const present = new Set<string>();
  for (const d of await store.drafts.list()) present.add(await draftKey(b, d));
  await b.runSliced(items.drafts, 50, async (chunk) => {
    for (const d of chunk) {
      const accountId = d.accountEmail ? idOf(d.accountEmail) : undefined;
      if (accountId === undefined) {
        left.drafts.push(d);
        continue;
      }
      const draft = await draftFrom(b, accountId, d);
      if (!draft) continue;
      const final = options.final === true || options.final === accountId;
      if (draft.mode === "new" && d.mode !== "new" && !final) {
        for (const ref of draft.attachments ?? []) await store.attachments.discard(accountId, ref.assetId);
        left.drafts.push(d);
        continue;
      }
      const key = await draftKey(b, draft);
      if (present.has(key)) {
        for (const ref of draft.attachments ?? []) await store.attachments.discard(accountId, ref.assetId);
        continue;
      }
      present.add(key);
      try { await store.drafts.save(draft, now); }
      catch (error) { for (const ref of draft.attachments ?? []) await store.attachments.discard(accountId, ref.assetId).catch(() => {}); throw error; }
      drafts++;
    }
  });
  return { filters, existingFilters, drafts, left };
}

/**
 * A mailbox was connected (or finished its first sync, `final`): what an
 * import kept for it goes in now. Cheap when nothing waits.
 */
export async function restorePending(b: Backend, final: number | false = false): Promise<void> {
  const pending = await pendingOf(b.store);
  if (!pending.drafts.length && !pending.filters.length) return;
  const r = await restoreInto(b, pending, { final });
  await savePending(b.store, r.left);
  if (r.drafts) b.server.emit("drafts", { reason: "import" });
}

/** What makes two drafts the same draft: where it goes, from where, and everything written in it. */
async function draftKey(b: Backend, d: DraftInput | DraftRow): Promise<string> {
  const norm = (list: unknown) => (list as DraftAddress[]).map((a) => [a.name, a.email, a.auto === true]);
  if ("account_id" in d) {
    return JSON.stringify([d.account_id, d.mode, d.subject, d.body_text, d.body_html, d.quoted_text, await attachmentKeys(b, d.account_id, JSON.parse(d.attachments_json ?? "[]")), norm(JSON.parse(d.to_json)), norm(JSON.parse(d.cc_json)), norm(JSON.parse(d.bcc_json))]);
  }
  return JSON.stringify([d.accountId, d.mode, d.subject, d.bodyText, d.bodyHtml ?? "", d.quotedText ?? "", await attachmentKeys(b, d.accountId, d.attachments ?? []), norm(d.to), norm(d.cc), norm(d.bcc ?? [])]);
}

/**
 * A draft from a file, for an account here. A reply or forward whose
 * original is here (by Message-ID) comes back as itself; otherwise it is a
 * new message whose kept quote joins its text, so nothing it would have sent
 * is hidden or lost.
 */
async function draftFrom(b: Backend, accountId: number, d: ExportDraft): Promise<DraftInput | null> {
  const to = addresses.safeParse(d.to);
  const cc = addresses.safeParse(d.cc);
  const bcc = addresses.safeParse(d.bcc ?? []);
  if (!to.success || !cc.success || !bcc.success) return null;
  const attachments = await importAttachments(b.store, accountId, d.attachments ?? [], b.now(), () => b.yieldTurn());
  const base = { attachments, accountId, to: to.data, cc: cc.data, bcc: bcc.data, subject: d.subject, subjectEdited: d.subjectEdited, uiState: d.uiState };
  const ref = d.mode === "forward" ? d.forwardOf : d.mode === "new" ? null : d.inReplyTo;
  const original = ref ? await b.store.drafts.findMessage(accountId, ref) : null;
  if (original) {
    return {
      ...base,
      mode: d.mode,
      threadId: original.threadId,
      bodyText: d.bodyText,
      bodyHtml: d.bodyHtml,
      quotedText: d.quotedText,
      includeQuote: d.includeQuote,
      inReplyToMessageId: d.mode === "forward" ? null : original.id,
      forwardOfMessageId: d.mode === "forward" ? original.id : null,
    };
  }
  const keepQuote = d.includeQuote && d.quotedText;
  const body = keepQuote ? [d.bodyText.replace(/\s+$/, ""), d.quotedText].filter(Boolean).join("\n\n") : d.bodyText;
  // a rich draft gets its quote in the HTML too (as lines and nested quotes), so what it would have sent stays;
  // converted in pieces with a turn between them (a quote can be megabytes: never one long block of the event loop)
  let html = d.bodyHtml;
  if (d.bodyHtml && keepQuote) {
    html = `${d.bodyHtml}${GAP}`;
    for (const piece of textToHtmlChunks(d.quotedText)) {
      html += piece;
      await b.yieldTurn();
    }
  }
  return { ...base, mode: "new", threadId: null, bodyText: body, bodyHtml: html, quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null };
}

/** The items of a list that are valid, read in time slices (a large file must not hold the event loop); `bad` gets what isn't. */
async function valid<T>(b: Backend, items: readonly unknown[], schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, bad?: (item: unknown) => void): Promise<T[]> {
  const out: T[] = [];
  await b.runSliced(items, 200, (chunk) => {
    for (const item of chunk) {
      const r = schema.safeParse(item);
      if (r.success) out.push(r.data);
      else bad?.(item);
    }
  });
  return out;
}

export async function importMailbox(b: Backend, file: ExportFile): Promise<ImportResult> {
  const store = b.store;
  const skipped: string[] = [];
  const named = (item: unknown) => skipped.push(String((item as { name?: unknown } | null)?.name ?? "?"));
  for (const item of file.drafts) {
    if (item && typeof item === "object" && "attachments" in item && !exportDraftSchema.safeParse(item).success) throw new RpcError("BAD_REQUEST", L("attachments.invalidBackup"));
  }
  const data = {
    accounts: file.accounts,
    settings: file.settings,
    categories: await valid<ExportCategory>(b, file.categories, exportCategorySchema),
    filters: await valid<ExportFilter>(b, file.filters, exportFilterSchema, named),
    drafts: await valid<ExportDraftItem>(b, file.drafts, exportDraftSchema),
  };

  let attachmentBytes = 0;
  const connected = new Set((await store.accounts.list()).map((a) => a.email.toLowerCase()));
  for (const d of data.drafts) {
    if (d.attachments?.length && (!d.accountEmail || !connected.has(d.accountEmail.toLowerCase()))) throw new RpcError("BAD_REQUEST", L("attachments.connectBeforeImport"));
    attachmentBytes += (d.attachments ?? []).reduce((n, a) => n + a.size, 0);
    if (attachmentBytes > 32 * 1024 * 1024) throw new RpcError("BAD_REQUEST", L("attachments.backupTooLarge"));
    await validateExportedAttachments(d.attachments ?? [], () => b.yieldTurn());
  }

  // categories: the same name (any case) is the same category; new ones are created in time slices
  const existing = await store.categories.list();
  const byName = new Map(existing.map((c) => [c.name.toLocaleLowerCase(), c.id]));
  const categoryIds = new Map<number, number>();
  const toCreate: ExportCategory[] = [];
  for (const c of [...data.categories].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))) {
    const known = byName.get(c.name.toLocaleLowerCase());
    if (known !== undefined) categoryIds.set(c.id, known);
    else if (!toCreate.some((x) => x.name.toLocaleLowerCase() === c.name.toLocaleLowerCase())) toCreate.push(c);
  }
  let added = 0;
  await b.runSliced(toCreate, 50, async (chunk) => {
    for (const c of chunk) {
      const made = await store.categories.create(c.name, c.color);
      if (c.autoApply === false) await store.categories.update(made.id, { autoApply: false });
      byName.set(c.name.toLocaleLowerCase(), made.id);
      added++;
    }
  });
  for (const c of data.categories) categoryIds.set(c.id, byName.get(c.name.toLocaleLowerCase())!);
  if (added) b.server.emit("categories", await store.categories.list());

  // filters: categories remapped; mailboxes by address. One naming a mailbox not connected yet waits for it (pending).
  const emailOfOld = new Map(data.accounts.flatMap((a) => (a.id === undefined ? [] : [[a.id, a.email.toLowerCase()] as const])));
  const waitingFilters: PendingFilter[] = [];
  for (const f of data.filters) {
    let ok = true;
    const actions = f.rule.actions.flatMap((a): FilterAction[] => {
      if (a.type !== "addCategory") return [a];
      const to = categoryIds.get(a.categoryId);
      if (to === undefined) ok = false;
      return to === undefined ? [] : [{ ...a, categoryId: to }];
    });
    const emails: Record<string, string> = {};
    for (const c of f.rule.conditions) {
      if (c.field !== "account") continue;
      const email = emailOfOld.get(c.value);
      if (email === undefined) ok = false;
      else emails[String(c.value)] = email;
    }
    if (!ok || actions.length === 0) skipped.push(f.name);
    else waitingFilters.push({ name: f.name, enabled: f.enabled, source: f.source, rule: { ...f.rule, actions }, accountEmails: emails });
  }

  // drafts and filters that need a mailbox go in now if it is here, else when it is connected
  const waiting = await pendingOf(store);
  // mailboxes here have synced what they have: a draft whose original isn't among it comes in as a new message
  const restored = await restoreInto(b, { filters: waitingFilters, drafts: data.drafts }, { final: true });
  await savePending(store, mergePending(waiting, restored.left));
  const left = mergePending(emptyPending, restored.left);
  if (restored.drafts) b.server.emit("drafts", { reason: "import" });

  // settings: never secrets; a cloud AI refused by local mode is left out, the rest applies
  let settings = false;
  if (data.settings && typeof data.settings === "object") {
    // saved keys stay bound to the endpoints they serve now: an imported endpoint has to be confirmed before one is sent there
    await pinKeyOrigins(store);
    const before = await readSettings(store);
    const { general, ai } = settingsFrom(data.settings as Record<string, unknown>, before);
    try {
      await updateSettings(store, { ...general, ai }, {});
      settings = true;
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      await updateSettings(store, general, {});
      settings = true;
    }
    const after = await readSettings(store);
    if (after.localMode !== before.localMode || after.errorReports !== before.errorReports || after.language !== before.language) await b.publishPolicy();
  }
  return {
    categories: { added, merged: data.categories.length - added },
    filters: { added: restored.filters, existing: restored.existingFilters, skipped },
    drafts: restored.drafts,
    pending: { drafts: left.drafts.length, filters: left.filters.length },
    settings,
  };
}
