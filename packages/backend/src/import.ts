import type { Condition, FilterAction, FilterRule } from "@unica/core";
import { draftAddressSchema, settingsPatchSchema, type DraftAddress, type ExportedDraft, type ExportFile, type ImportResult, type MailboxExport, type SettingsPatch } from "@unica/core/rpc";
import type { DraftInput } from "@unica/store";
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

/**
 * A draft from a file, for an account here. A reply or forward whose
 * original is here (by Message-ID) comes back as itself; otherwise it is a
 * new message whose kept quote joins its text, so nothing it would have sent
 * is hidden or lost.
 */
async function draftFrom(b: Backend, accountId: number, d: ExportFile["drafts"][number]): Promise<DraftInput | null> {
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
  const now = b.now();

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

  // filters: categories and mailboxes remapped; a filter that names a mailbox not connected here would change meaning, so it stays out
  const accounts = await store.accounts.list();
  const accountIds = new Map<number, number>();
  for (const a of data.accounts) {
    const here = accounts.find((x) => x.email === a.email.toLowerCase());
    if (a.id !== undefined && here) accountIds.set(a.id, here.id);
  }
  const current = await store.filters.list();
  const same = new Set(current.map((f) => `${f.name}\n${JSON.stringify(f.rule)}`));
  const skipped: string[] = [];
  let addedFilters = 0;
  let existingFilters = 0;
  for (const f of data.filters) {
    let ok = true;
    const conditions = f.rule.conditions.map((c): Condition => {
      if (c.field !== "account") return c;
      const to = accountIds.get(c.value);
      if (to === undefined) ok = false;
      return { ...c, value: to ?? c.value };
    });
    const actions = f.rule.actions.flatMap((a): FilterAction[] => {
      if (a.type !== "addCategory") return [a];
      const to = categoryIds.get(a.categoryId);
      if (to === undefined) ok = false;
      return to === undefined ? [] : [{ ...a, categoryId: to }];
    });
    if (!ok || actions.length === 0) {
      skipped.push(f.name);
      continue;
    }
    const rule: FilterRule = { ...f.rule, conditions, actions };
    if (same.has(`${f.name}\n${JSON.stringify(rule)}`)) {
      existingFilters++;
      continue;
    }
    await store.filters.save({ name: f.name, enabled: f.enabled, source: f.source, rule }, now);
    addedFilters++;
  }

  // drafts of mailboxes connected here come back as new messages
  let drafts = 0;
  for (const d of data.drafts) {
    const account = accounts.find((a) => a.email === d.accountEmail?.toLowerCase());
    const draft = account ? await draftFrom(b, account.id, d) : null;
    if (!draft) continue;
    await store.drafts.save(draft, now);
    drafts++;
  }

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
  return { categories: { added, merged: data.categories.length - added }, filters: { added: addedFilters, existing: existingFilters, skipped }, drafts, settings };
}
