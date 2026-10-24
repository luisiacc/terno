import type { Condition, FilterAction, FilterRule } from "@unica/core";
import { draftAddressSchema, settingsPatchSchema, type ExportFile, type ImportResult, type SettingsPatch } from "@unica/core/rpc";
import type { BackendCore as Backend } from "./core";
import { readSettings, SettingsError, updateSettings } from "./settings";

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
    const to = addresses.safeParse(d.to);
    const cc = addresses.safeParse(d.cc);
    if (!account || !to.success || !cc.success) continue;
    await store.drafts.save({ accountId: account.id, mode: "new", to: to.data, cc: cc.data, subject: d.subject, bodyText: d.bodyText }, now);
    drafts++;
  }

  // settings: never secrets; a cloud AI refused by local mode is left out, the rest applies
  let settings = false;
  if (data.settings && typeof data.settings === "object") {
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
