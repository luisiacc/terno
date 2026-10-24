import type { Condition, FilterAction, FilterRule } from "@unica/core";
import { draftAddressSchema, settingsPatchSchema, type DraftAddress, type ExportedDraft, type ExportFile, type ImportResult, type MailboxExport, type SettingsPatch } from "@unica/core/rpc";
import type { DraftInput, DraftRow } from "@unica/store";
import type { BackendCore as Backend } from "./core";
import { pinKeyOrigins, readSettings, SettingsError, updateSettings } from "./settings";

const GENERAL_KEYS = [
  "theme",
  "lightTheme",
  "darkTheme",
  "motionMs",
  "htmlMailAppearance",
  "customThemes",
  "density",
  "remoteImages",
  "gmailClientId",
  "syncWindowDays",
  "autoCategorize",
  "aiCategorize",
] as const;

const addresses = draftAddressSchema.array().max(200);

/** The settings an export carries, as a patch: each field only if valid on its own; secrets never travel. */
function settingsFrom(raw: Record<string, unknown>, current: { localMode: boolean; allowAgentSend: boolean }): { general: SettingsPatch; ai: SettingsPatch["ai"] } {
  const general: Record<string, unknown> = {};
  for (const key of GENERAL_KEYS) {
    if (raw[key] === undefined) continue;
    const r = settingsPatchSchema.safeParse({ [key]: raw[key] });
    if (r.success) general[key] = (r.data as Record<string, unknown>)[key];
  }
  // a file never makes this install less private: local mode can come on, agent sending can go off
  if (raw.localMode === true && !current.localMode) general.localMode = true;
  if (raw.allowAgentSend === false && current.allowAgentSend) general.allowAgentSend = false;
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
      quotedText: d.quoted_text,
      includeQuote: d.include_quote === 1,
      inReplyTo: await ref(d.in_reply_to_message_id),
      forwardOf: await ref(d.forward_of_message_id),
      uiState: d.ui_state,
      updatedAt: d.updated_at,
    });
  }
  return {
    format: "unica-export",
    version: 2,
    exportedAt: b.now(),
    app: b.options.version,
    accounts: accounts.map((a) => ({ id: a.id, email: a.email, kind: a.kind, displayName: a.displayName })),
    categories: await store.categories.list(),
    filters: await store.filters.list(),
    settings: await readSettings(store),
    drafts,
    ops: (await store.ops.recent(100_000))
      .filter((o) => o.state !== "succeeded")
      .map((o) => ({ accountEmail: emailOf(o.account_id), kind: o.kind, state: o.state, createdAt: o.created_at, lastError: o.last_error, target: JSON.parse(o.target_json), payload: JSON.parse(o.payload_json) })),
  };
}

type ExportDraft = ExportFile["drafts"][number];
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
async function restoreInto(b: Backend, items: Pending, options: { final: boolean | number }): Promise<{ filters: number; existingFilters: number; drafts: number; left: Pending }> {
  const store = b.store;
  const now = b.now();
  const accounts = await store.accounts.list();
  const idOf = (email: string) => accounts.find((a) => a.email === email.toLowerCase())?.id;
  const left: Pending = { drafts: [], filters: [] };
  const same = new Set((await store.filters.list()).map((f) => `${f.name}\n${JSON.stringify(f.rule)}`));
  let filters = 0;
  let existingFilters = 0;
  for (const f of items.filters) {
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
  let drafts = 0;
  const present = new Set((await store.drafts.list()).map(draftKey));
  for (const d of items.drafts) {
    const accountId = d.accountEmail ? idOf(d.accountEmail) : undefined;
    if (accountId === undefined) {
      left.drafts.push(d);
      continue;
    }
    const draft = await draftFrom(b, accountId, d);
    if (!draft) continue;
    const final = options.final === true || options.final === accountId;
    if (draft.mode === "new" && d.mode !== "new" && !final) {
      left.drafts.push(d);
      continue;
    }
    const key = draftKey(draft);
    if (present.has(key)) continue;
    present.add(key);
    await store.drafts.save(draft, now);
    drafts++;
  }
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
function draftKey(d: DraftInput | DraftRow): string {
  const norm = (list: unknown) => (list as DraftAddress[]).map((a) => [a.name, a.email, a.auto === true]);
  if ("account_id" in d) {
    return JSON.stringify([d.account_id, d.mode, d.subject, d.body_text, d.quoted_text, norm(JSON.parse(d.to_json)), norm(JSON.parse(d.cc_json)), norm(JSON.parse(d.bcc_json))]);
  }
  return JSON.stringify([d.accountId, d.mode, d.subject, d.bodyText, d.quotedText ?? "", norm(d.to), norm(d.cc), norm(d.bcc ?? [])]);
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
  const base = { accountId, to: to.data, cc: cc.data, bcc: bcc.data, subject: d.subject, subjectEdited: d.subjectEdited, uiState: d.uiState };
  const ref = d.mode === "forward" ? d.forwardOf : d.mode === "new" ? null : d.inReplyTo;
  const original = ref ? await b.store.drafts.findMessage(accountId, ref) : null;
  if (original) {
    return {
      ...base,
      mode: d.mode,
      threadId: original.threadId,
      bodyText: d.bodyText,
      quotedText: d.quotedText,
      includeQuote: d.includeQuote,
      inReplyToMessageId: d.mode === "forward" ? null : original.id,
      forwardOfMessageId: d.mode === "forward" ? original.id : null,
    };
  }
  const body = d.includeQuote && d.quotedText ? [d.bodyText.replace(/\s+$/, ""), d.quotedText].filter(Boolean).join("\n\n") : d.bodyText;
  return { ...base, mode: "new", threadId: null, bodyText: body, quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null };
}

export async function importMailbox(b: Backend, data: ExportFile): Promise<ImportResult> {
  const store = b.store;

  // categories: the same name (any case) is the same category
  const existing = await store.categories.list();
  const byName = new Map(existing.map((c) => [c.name.toLocaleLowerCase(), c.id]));
  const categoryIds = new Map<number, number>();
  let added = 0;
  for (const c of [...data.categories].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))) {
    const known = byName.get(c.name.toLocaleLowerCase());
    if (known !== undefined) {
      categoryIds.set(c.id, known);
      continue;
    }
    const made = await store.categories.create(c.name, c.color);
    if (c.autoApply === false) await store.categories.update(made.id, { autoApply: false });
    byName.set(c.name.toLocaleLowerCase(), made.id);
    categoryIds.set(c.id, made.id);
    added++;
  }
  if (added) b.server.emit("categories", await store.categories.list());

  // filters: categories remapped; mailboxes by address. One naming a mailbox not connected yet waits for it (pending).
  const emailOfOld = new Map(data.accounts.flatMap((a) => (a.id === undefined ? [] : [[a.id, a.email.toLowerCase()] as const])));
  const skipped: string[] = [];
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
    if ((await readSettings(store)).localMode !== before.localMode) await b.publishPolicy();
  }
  return {
    categories: { added, merged: data.categories.length - added },
    filters: { added: restored.filters, existing: restored.existingFilters, skipped },
    drafts: restored.drafts,
    pending: { drafts: left.drafts.length, filters: left.filters.length },
    settings,
  };
}
