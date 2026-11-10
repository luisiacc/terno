import { ACTION_PROMPT_VERSION, AiError, CHECK_NAME_CHARS, CHECK_SUBJECT_CHARS, checkBudget, type AiTasks, type CheckGroup } from "@terno/ai";
import {
  baseSubject,
  capFilterName,
  filterRuleSchema,
  normalizeText,
  redactAddresses,
  subjectKey,
  CONSUMER_DOMAINS,
  CATEGORY_COLORS,
  type ActionKeep,
  type ActionPlan,
  type ActionRowTag,
  type ActionPreviewInfo,
  type AiActionApplied,
  type AiActionCheck,
  type AiActionStart,
  type Category,
  type Condition,
  type FilterRule,
  type ThreadSummary,
  savesRuleOnly,
} from "@terno/core";
import { RpcError, type ParsedParamsOf } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { ActionThreadFacts } from "@terno/store";
import type { BackendCore as Backend } from "./core";
import type { TopLeft } from "./inbox-top";
import { SCOPE_CAP, progressReporter } from "./scope";
import { readSettings } from "./settings";
import { destinationOf } from "./voice-learner";

/**
 * Plan 143: a sentence that does something. The model writes a rule, Terno finds what it matches here, the model may
 * only remove what doesn't fit (from senders and subjects, never a body or an address), and nothing runs until Apply.
 * One Undo reverses all of it. Nothing this file logs carries mail.
 */

const PREVIEW_MS = 30 * 60_000;
const WINDOW = 4000;
const WINDOW_PATTERN = 1000;
/** a body read is the slow part: few enough that a window stays inside the slicer's budget */
const WINDOW_BODY = 400;
const EMIT_EVERY_MS = 150;
/** at most this many provider requests for one check, repairs included (revision 9) */
const CHECK_PROVIDER_REQUESTS = 6;
const CHECK_REQUESTS = 3;
const CONDITIONS_MAX = 20;
const UNDOS_KEPT = 16;

type StartParams = ParsedParamsOf<"ai.actionStart">;

/** Handlers' own steps: each journaled as the rest of the app's are, each stopping between slices. */
export interface ActionOps {
  act(ids: number[], action: "archive" | "trash" | "spam" | "markRead" | "star", narrow: Narrow, progress: (done: number) => void): Promise<{ undoId: number | null }>;
  toFolder(accountId: number, folder: string, ids: number[], narrow: Narrow, progress: (done: number) => void): Promise<{ undoId: number | null }>;
  /** one slice's move, finished: stopping never leaves one for startup to resume */
  toCategory(categoryId: number, ids: number[], narrow: Narrow, record: (step: MoveStep) => void): Promise<void>;
  undoActs(undoId: number, jobId: string | undefined): Promise<number>;
  undoMove(step: MoveStep): Promise<number>;
  ensureFilter(rule: FilterRule, name: string): Promise<{ filterUndo: number | null }>;
  undoFilter(filterUndo: number): Promise<void>;
  categoriesChanged(): Promise<void>;
}
type Narrow = (chunk: number[]) => Promise<number[]>;
export interface MoveStep {
  batchId: number;
  /** what the Inbox's top held that the move ended (a category hidden from the Inbox) */
  left: TopLeft;
}

type UndoStep = { kind: "acts"; undoId: number } | { kind: "moves"; steps: MoveStep[] } | { kind: "filter"; filterUndo: number } | { kind: "category"; made: Category };

interface Group extends CheckGroup {
  ids: number[];
}

interface Preview {
  id: string;
  clientId: string;
  plan: ActionPlan;
  sentence: string;
  conversationId: number | null;
  usedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
  scanning: boolean;
  /** in the order shown */
  ids: number[];
  /** starred or replied in */
  skipped: number[];
  includeSkipped: boolean;
  stamps: Map<number, { lastDate: number; messageCount: number }>;
  /** rows the user unticked */
  unticked: Set<number>;
  /** rows the check dropped, and rows it hasn't reached */
  leftOut: Set<number>;
  unchecked: Set<number>;
  /** rows of those two the user ticked back */
  back: Set<number>;
  /**
   * Plan 162 (after ai162-r04): starred or replied rows included that the check never saw (or hasn't yet): shown, unticked,
   * for the user to tick one by one (Include took them all, past the check)
   */
  held: Set<number>;
  check: ActionPreviewInfo["check"];
  groups: Group[] | null;
  nextGroup: number;
  keptGroups: Group[];
  droppedGroups: Group[];
  categoryForwards: boolean;
  categoryHidden: boolean;
  categoryName: string | null;
  applying: boolean;
  stop: boolean;
  accounts: Set<number>;
  /** what the rule found that the action has nothing to do to */
  ineligible: number;
  clearGeneration: number;
  /** ends what it has underway the moment it's dropped */
  controller: AbortController;
}

/** A conversation as the check sees it: its last sender's name and domain, and its subject (never an address or a body). */
const groupOf = (f: ActionThreadFacts) => ({
  name: redactAddresses(f.lastFromName).slice(0, CHECK_NAME_CHARS),
  domain: domainOf(f.lastFromEmail),
  subject: subjectKey(normalizeText(baseSubject(redactAddresses(f.subject)))).slice(0, CHECK_SUBJECT_CHARS),
});
const groupKey = (g: { name: string; domain: string; subject: string }) => `${g.name}\u0000${g.domain}\u0000${g.subject}`;
const stampOf = (f: ActionThreadFacts) => ({ lastDate: f.lastDate, messageCount: f.messageCount });
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
const targetCategory = (plan: ActionPlan) => (plan.action.type === "moveToCategory" ? plan.action.categoryId : undefined);

/** Whether the action has anything to do to this thread, wherever the sentence looks. */
export function eligible(plan: ActionPlan, f: ActionThreadFacts): boolean {
  if (f.inTrash || f.inSpam) return false;
  if ((plan.lookIn === "inbox" || plan.action.type === "archive") && !f.inInbox) return false;
  switch (plan.action.type) {
    case "markRead":
      return f.unread;
    case "star":
      return !f.starred;
    case "moveToCategory":
      return !f.inCategory;
    case "moveToFolder":
      return f.accountId === plan.action.accountId;
    default:
      return true;
  }
}

/** A star on a starred thread's neighbour costs nothing to spare, so starring spares nothing. */
const spares = (plan: ActionPlan, f: ActionThreadFacts) => plan.action.type !== "star" && (f.starred || f.replied);

export function orderByDate(ids: readonly number[], stamps: ReadonlyMap<number, { lastDate: number }>): number[] {
  const dates = Float64Array.from(ids, (id) => stamps.get(id)?.lastDate ?? 0);
  const at = Uint32Array.from(ids, (_, i) => i).sort((a, b) => dates[b]! - dates[a]! || ids[b]! - ids[a]!);
  return Array.from(at, (i) => ids[i]!);
}

export class ActionsService {
  private readonly previews = new Map<string, Preview>();
  private readonly undos = new Map<string, UndoStep[]>();
  private ops: ActionOps | null = null;
  private undoSeq = 0;

  constructor(private readonly b: Backend) {}

  bind(ops: ActionOps): void {
    this.ops = ops;
  }

  private drop(p: Preview): void {
    p.dead = true;
    p.controller.abort();
    // what it held of the mail goes with it
    p.groups = null;
    p.keptGroups = [];
    p.droppedGroups = [];
    p.ids = [];
    p.skipped = [];
    p.stamps.clear();
    if (p.timer) clearTimeout(p.timer);
    this.previews.delete(p.id);
  }

  /** Its own connection's, and within its time: a preview past either says so and acts on nothing. */
  private held(previewId: string, clientId: string): Preview {
    const p = this.previews.get(previewId);
    if (!p || p.clientId !== clientId) throw new RpcError("NOT_FOUND", L("errors.ai.actionGone"));
    if (this.b.now() - p.usedAt > PREVIEW_MS && !p.applying) {
      this.drop(p);
      throw new RpcError("NOT_FOUND", L("errors.ai.actionGone"));
    }
    this.touch(p);
    return p;
  }

  private touch(p: Preview): void {
    p.usedAt = this.b.now();
    if (p.timer) clearTimeout(p.timer);
    // one shot, to let go of the ids: nothing spins while it waits
    if (p.dead) return;
    p.timer = setTimeout(() => {
      if (!p.applying) this.drop(p);
    }, PREVIEW_MS);
    (p.timer as { unref?: () => void }).unref?.();
  }

  /** An account removed (or, null, Clear AI data): nothing held of its mail goes on being read or sent. */
  invalidate(accountId: number | null): void {
    for (const p of this.previews.values()) {
      if (accountId !== null && !p.accounts.has(accountId) && !p.groups) continue;
      p.stop = true;
      if (!p.applying) {
        this.drop(p);
        this.b.server.emitTo(p.clientId, "aiAction", { previewId: p.id, ended: "failed" });
      }
    }
  }

  disconnected(clientId: string): void {
    for (const p of this.previews.values()) {
      if (p.clientId !== clientId) continue;
      p.stop = true;
      if (!p.applying) this.drop(p);
    }
  }

  private ticked(p: Preview, id: number): boolean {
    if (p.leftOut.has(id) || p.unchecked.has(id) || p.held.has(id)) return p.back.has(id);
    return !p.unticked.has(id);
  }

  private rows(p: Preview): number[] {
    return p.includeSkipped ? [...p.ids, ...p.skipped] : p.ids;
  }

  private count(p: Preview): number {
    let n = 0;
    for (const id of this.rows(p)) if (this.ticked(p, id)) n++;
    return n;
  }

  private keep(p: Preview): { keep: ActionKeep; conditions: Condition[] } {
    const { conditions } = p.plan;
    if (conditions.some((c) => c.field === "ageDays")) return { keep: { kind: "hidden" }, conditions };
    if (p.categoryForwards) return { keep: { kind: "disabled", reason: "forwarding" }, conditions };
    if (p.unchecked.size > 0) return { keep: { kind: "disabled", reason: "exceptions" }, conditions };
    // a dropped group isn't a sender (revision 6): only a domain that's wholly dropped, and nobody's shared one, can say it
    const keptDomains = new Set(p.keptGroups.map((g) => g.domain));
    const dropped = [...new Set(p.droppedGroups.map((g) => g.domain))];
    const fits = dropped.every((d) => d !== "" && !keptDomains.has(d) && !CONSUMER_DOMAINS.has(d)) && conditions.length + dropped.length <= CONDITIONS_MAX;
    if (!fits) return { keep: { kind: "disabled", reason: "exceptions" }, conditions };
    const held: Condition[] = [...conditions, ...dropped.map((value): Condition => ({ field: "fromDomain", op: "equals", value, negate: true }))];
    if (!filterRuleSchema.safeParse(this.ruleFor(p.plan, held, 1)).success) return { keep: { kind: "disabled", reason: "exceptions" }, conditions };
    return { keep: { kind: "ok" }, conditions: held };
  }

  private ruleFor(plan: ActionPlan, conditions: readonly Condition[], categoryId: number | null): FilterRule {
    const { action } = plan;
    switch (action.type) {
      case "moveToCategory":
        return { match: "all", conditions: [...conditions], actions: [{ type: "addCategory", categoryId: action.categoryId }] };
      case "createCategory":
        return { match: "all", conditions: [...conditions], actions: [{ type: "addCategory", categoryId: categoryId! }] };
      case "moveToFolder":
        return { match: "all", conditions: [...conditions], actions: [{ type: "moveToFolder", accountId: action.accountId, folder: action.folder }] };
      default:
        return { match: "all", conditions: [...conditions], actions: [{ type: action.type }] };
    }
  }

  private info(p: Preview): ActionPreviewInfo {
    const { keep, conditions } = this.keep(p);
    return {
      previewId: p.id,
      plan: p.plan,
      count: this.count(p),
      found: p.ids.length + p.skipped.length,
      skipped: p.skipped.length,
      skippedIncluded: p.includeSkipped,
      skippedTicked: p.includeSkipped ? p.skipped.filter((id) => this.ticked(p, id)).length : 0,
      leftOut: p.leftOut.size,
      unchecked: p.unchecked.size,
      check: p.check,
      keep,
      keepConditions: conditions,
      scanning: p.scanning,
      hidden: p.categoryHidden,
      categoryName: p.categoryName,
      forwards: p.categoryForwards,
    };
  }

  private emit(p: Preview): void {
    this.b.server.emitTo(p.clientId, "aiAction", { previewId: p.id, preview: this.info(p) });
  }

  async start(params: StartParams, clientId: string): Promise<AiActionStart> {
    const { store } = this.b;
    const { signal, release } = this.b.aiService.begin(params.requestId, clientId);
    // before anything it writes was read: a clear after this point makes the write refuse itself
    const clearGeneration = store.ask.history.clearGeneration();
    try {
      const settings = await readSettings(store);
      if (!settings.ask.enabled) throw new AiError(L("errors.ai.askOff"), "not_configured");
      const { planner } = await this.b.ask.target();
      const now = this.b.now();
      const categories = await store.categories.list();
      const accounts = await store.accounts.list();
      const plan = await planner.planAction(
        {
          sentence: params.sentence,
          today: dayIn(now, params.timezone),
          timezone: params.timezone,
          accounts: accounts.map((a) => ({ id: a.id, email: a.email, displayName: a.displayName })),
          categories: categories.map((c) => ({ id: c.id, name: c.name })),
          folders: (await store.folders.list()).filter((f) => f.selectable).map((f) => ({ accountId: f.accountId, key: f.key, name: f.path.at(-1) ?? f.key })),
          now,
        },
        signal,
      );
      if (!plan) return { status: "refused" };
      if (!plan.conditions.length) return { status: "noCondition" };
      const category = categories.find((c) => c.id === targetCategory(plan));
      const p: Preview = {
        id: globalThis.crypto.randomUUID(),
        clientId,
        plan,
        sentence: params.sentence,
        conversationId: params.conversationId ?? null,
        usedAt: now,
        timer: null,
        dead: false,
        scanning: true,
        ids: [],
        skipped: [],
        includeSkipped: false,
        stamps: new Map(),
        unticked: new Set(),
        leftOut: new Set(),
        unchecked: new Set(),
        back: new Set(),
        held: new Set(),
        check: plan.meaning ? "needed" : "none",
        groups: null,
        nextGroup: 0,
        keptGroups: [],
        droppedGroups: [],
        categoryForwards: category?.forward?.enabled === true,
        categoryHidden: plan.action.type === "createCategory" || category?.showInInbox === false,
        categoryName: plan.action.type === "createCategory" ? plan.action.name : (category?.name ?? null),
        applying: false,
        stop: false,
        accounts: new Set(),
        ineligible: 0,
        clearGeneration,
        controller: new AbortController(),
      };
      this.previews.set(p.id, p);
      this.touch(p);
      // the preview opens with the first rows, and the count goes on growing there; nothing at all stays on the page
      const opened = await new Promise<"open" | "none" | "tooMany">((resolve, reject) => {
        void this.scan(p, signal, resolve).catch((error: unknown) => {
          this.drop(p);
          reject(error);
          this.b.server.emitTo(clientId, "aiAction", { previewId: p.id, ended: "failed" });
        });
      });
      if (opened === "tooMany") return { status: "tooMany" };
      if (opened === "none") return { status: "noMatch", summary: plan.summary, ...(p.ineligible ? { done: p.ineligible } : {}) };
      return { status: "preview", preview: this.info(p) };
    } finally {
      release();
    }
  }

  /** Once through the mailbox, newest first, with a turn between windows (revision 11). */
  private async scan(p: Preview, asked: AbortSignal, opened: (how: "open" | "none" | "tooMany") => void): Promise<void> {
    const { store } = this.b;
    const rule = this.ruleFor(p.plan, p.plan.conditions, 0);
    const size = p.plan.conditions.some((c) => c.field === "body" || c.field === "text") ? WINDOW_BODY : p.plan.conditions.some((c) => "op" in c && c.op === "matches") ? WINDOW_PATTERN : WINDOW;
    const cap = this.b.options.similarCap ?? SCOPE_CAP;
    const now = this.b.now();
    const walk = store.filters.messageWalk();
    const seen = new Set<number>();
    let told = false;
    let last = 0;
    for (;;) {
      if (p.dead || (!told && asked.aborted)) {
        this.drop(p);
        if (!told) opened("none");
        return;
      }
      const page = await walk.next(size);
      if (!page.length) break;
      const matched = await store.filters.matchMessages(rule, now, page);
      const threads = matched.length ? (await store.filters.threadsOf(matched)).filter((id) => !seen.has(id)) : [];
      for (const id of threads) seen.add(id);
      if (threads.length) {
        const facts = await store.filters.actionFacts(threads, targetCategory(p.plan));
        for (const f of facts) {
          if (!eligible(p.plan, f)) {
            p.ineligible++;
            continue;
          }
          p.stamps.set(f.id, stampOf(f));
          p.accounts.add(f.accountId);
          (spares(p.plan, f) ? p.skipped : p.ids).push(f.id);
        }
      }
      if (p.ids.length + p.skipped.length > cap) {
        // the first it hears of it, or from a preview already open
        if (!told) opened("tooMany");
        else this.b.server.emitTo(p.clientId, "aiAction", { previewId: p.id, ended: "tooMany" });
        this.drop(p);
        return;
      }
      if (!told && (p.ids.length || p.skipped.length)) {
        told = true;
        opened("open");
      }
      if (told && performance.now() - last > EMIT_EVERY_MS) {
        last = performance.now();
        this.emit(p);
      }
      await this.b.yieldTurn();
    }
    if (!p.ids.length && !p.skipped.length) {
      // it asked for mail to come, and that needs no mail here: the preview offers the rule alone
      if (!savesRuleOnly(this.info(p))) {
        this.drop(p);
        opened("none");
        return;
      }
      p.check = "none";
    }
    this.order(p);
    p.scanning = false;
    if (!told) opened("open");
    else this.emit(p);
  }

  /** The newest first, as any list: typed arrays, so a hundred thousand rows are a moment's work. */
  private order(p: Preview): void {
    p.ids = orderByDate(p.ids, p.stamps);
    p.skipped = orderByDate(p.skipped, p.stamps);
  }

  async page(previewId: string, offset: number, limit: number, showLeftOut: boolean, clientId: string): Promise<{ items: ThreadSummary[]; total: number; unticked: number[]; tags: [number, ActionRowTag][] }> {
    const p = this.held(previewId, clientId);
    const rows = this.rows(p);
    const main = rows.filter((id) => !p.leftOut.has(id) && !p.unchecked.has(id));
    const ordered = showLeftOut ? [...main, ...rows.filter((id) => p.leftOut.has(id) || p.unchecked.has(id))] : main;
    const ids = ordered.slice(offset, offset + limit);
    // a row acted on by hand since no longer belongs; Apply counts it as changed
    const still = new Set((await this.b.store.filters.actionFacts(ids, targetCategory(p.plan))).filter((f) => eligible(p.plan, f)).map((f) => f.id));
    const found = new Map((await this.b.store.threads.summaries(ids.filter((id) => still.has(id)))).map((t) => [t.id, t]));
    const items = ids.flatMap((id) => found.get(id) ?? []);
    // plan 162 (after ai162-r05): why a row that isn't plainly a match is in the list, so the kinds read apart once shown
    // (the check's verdict, not checked yet, or starred or replied brought in by Include)
    const skipped = new Set(p.skipped);
    const tags = items.flatMap((t): [number, ActionRowTag][] => (p.leftOut.has(t.id) ? [[t.id, "leftOut"]] : p.unchecked.has(t.id) ? [[t.id, "unchecked"]] : skipped.has(t.id) || p.held.has(t.id) ? [[t.id, "protected"]] : []));
    return { items, total: ordered.length, unticked: ids.filter((id) => !this.ticked(p, id)), tags };
  }

  toggle(previewId: string, threadId: number, included: boolean, clientId: string): ActionPreviewInfo {
    const p = this.held(previewId, clientId);
    if (p.leftOut.has(threadId) || p.unchecked.has(threadId) || p.held.has(threadId)) {
      if (included) p.back.add(threadId);
      else p.back.delete(threadId);
    } else if (included) p.unticked.delete(threadId);
    else p.unticked.add(threadId);
    return this.info(p);
  }

  async includeSkipped(previewId: string, included: boolean, clientId: string): Promise<ActionPreviewInfo> {
    const p = this.held(previewId, clientId);
    // Codex review: held (unticked) before anything waits, so an Apply meanwhile never takes one the check rejected; and
    // left out again, nothing of theirs is counted (Show counted rows it no longer listed)
    for (const id of p.skipped) {
      p.leftOut.delete(id);
      p.back.delete(id);
      if (included) p.held.add(id);
      else p.held.delete(id);
    }
    p.includeSkipped = included;
    if (included) await this.sortSkipped(p);
    return this.info(p);
  }

  /**
   * Plan 162 (after ai162-r04): the starred or replied conversations Include brings in go past what the check decided, by
   * its own groups (a sender and a subject; no model): one in a group it kept is ticked, one in a group it left out is left
   * out, and one it never saw is held, unticked, for the user to tick. With no check (the rule was certain), all are ticked.
   */
  private async sortSkipped(p: Preview): Promise<void> {
    const skipped = p.skipped;
    // held, unticked, while this works: what it decides is put in at once, at the end (Codex review)
    for (const id of skipped) {
      p.leftOut.delete(id);
      p.back.delete(id);
      p.held.add(id);
    }
    if (p.check === "none" || p.check === "skipped") {
      for (const id of skipped) p.held.delete(id);
      return;
    }
    // the check hasn't said yet: held until it has (check() sorts them then)
    if (p.check === "needed" || !p.groups) return;
    const kept = new Set(p.keptGroups.map(groupKey));
    const dropped = new Set(p.droppedGroups.map(groupKey));
    const ticked: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < skipped.length; i += 1000) {
      const slice = skipped.slice(i, i + 1000);
      const facts = new Map((await this.b.store.filters.actionFacts(slice)).map((f) => [f.id, f]));
      for (const id of slice) {
        const f = facts.get(id);
        const key = f ? groupKey(groupOf(f)) : null;
        if (key !== null && kept.has(key)) ticked.push(id);
        else if (key !== null && dropped.has(key)) out.push(id);
      }
      await this.b.yieldTurn();
    }
    // left out again (Skip them) while it worked: nothing of it applies
    if (!p.includeSkipped || p.dead) return;
    for (const id of ticked) p.held.delete(id);
    for (const id of out) {
      p.held.delete(id);
      p.leftOut.add(id);
    }
  }

  /** Where senders and subjects go: the check's first destination, checked again before each dispatch (revision 7), so a provider changed meanwhile gets nothing. */
  private async stillThere(destination: string, signal: AbortSignal): Promise<AiTasks> {
    if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    const { ai, planner } = await this.b.ask.target();
    if (destinationOf(ai) !== destination) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    return planner;
  }

  /** Every row, as a group of a sender and a subject, newest first: never a body, never a whole address. */
  private async buildGroups(p: Preview): Promise<void> {
    if (p.groups) return;
    const gone = () => new AiError(L("errors.ai.cancelled"), "cancelled");
    const byKey = new Map<string, Group>();
    const ids = p.ids;
    for (let i = 0; i < ids.length; i += 1000) {
      const slice = ids.slice(i, i + 1000);
      const facts = new Map((await this.b.store.filters.actionFacts(slice)).map((f) => [f.id, f]));
      // the preview's order, newest first, whatever order a store answers in
      for (const id of slice) {
        const f = facts.get(id);
        if (!f) continue;
        const { name, domain, subject } = groupOf(f);
        const key = groupKey({ name, domain, subject });
        let g = byKey.get(key);
        if (!g) byKey.set(key, (g = { label: `g${byKey.size + 1}`, name, domain, subject, count: 0, ids: [] }));
        g.count++;
        g.ids.push(f.id);
      }
      await this.b.yieldTurn();
      if (p.dead) throw gone();
    }
    p.groups = [...byKey.values()];
    // not reached yet: left out until it is
    for (const id of ids) p.unchecked.add(id);
  }

  async check(params: ParsedParamsOf<"ai.actionCheck">, clientId: string): Promise<AiActionCheck> {
    const p = this.held(params.previewId, clientId);
    if (p.scanning) throw new RpcError("BAD_REQUEST", L("errors.ai.actionNotReady"));
    if (params.skip) {
      // nothing sent: the rule's matches are what they are, whatever a check that failed had set up
      if (p.check === "needed") {
        p.check = "skipped";
        p.unchecked.clear();
        p.groups = null;
        p.nextGroup = 0;
        if (p.includeSkipped) await this.sortSkipped(p);
      }
      return { status: "done", preview: this.info(p) };
    }
    if (p.check !== "needed" && !(p.check === "done" && p.unchecked.size > 0)) return { status: "done", preview: this.info(p) };
    const { signal: asked, release } = this.b.aiService.begin(params.requestId, clientId);
    const signal = AbortSignal.any([asked, p.controller.signal]);
    try {
      const { destination } = await this.b.ask.target();
      await this.buildGroups(p);
      const budget = { left: CHECK_PROVIDER_REQUESTS };
      const groups = p.groups!;
      let sent = 0;
      try {
        for (let r = 0; r < CHECK_REQUESTS && p.nextGroup < groups.length && !p.dead; r++) {
          const planner = await this.stillThere(destination, signal);
          const fit = checkBudget(planner.contextTokens);
          if (fit.groups === 0) break;
          const batch = groups.slice(p.nextGroup, p.nextGroup + fit.groups);
          const drop = new Set(await planner.checkCandidates({ sentence: p.sentence, destructive: p.plan.action.type === "trash" || p.plan.action.type === "spam", groups: batch.map(({ ids: _ids, ...g }) => g) }, { outputTokens: fit.outputTokens, budget, signal }));
          p.nextGroup += batch.length;
          sent++;
          for (const g of batch) {
            (drop.has(g.label) ? p.droppedGroups : p.keptGroups).push(g);
            for (const id of g.ids) {
              p.unchecked.delete(id);
              if (drop.has(g.label)) p.leftOut.add(id);
            }
          }
        }
      } catch (error) {
        // a later request failed: what was checked stands, the rest stays left out and said
        if (sent === 0 || (error instanceof AiError && error.kind === "cancelled")) throw error;
      }
      if (p.dead) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      p.check = "done";
      if (p.includeSkipped) await this.sortSkipped(p);
      this.touch(p);
      return { status: "done", preview: this.info(p) };
    } finally {
      release();
    }
  }

  cancel(previewId: string, clientId: string): void {
    const p = this.previews.get(previewId);
    if (p?.clientId === clientId && !p.applying) this.drop(p);
  }

  stop(previewId: string, clientId: string): void {
    const p = this.previews.get(previewId);
    if (p?.clientId === clientId) p.stop = true;
  }

  private remember(steps: UndoStep[]): string | null {
    if (!steps.length) return null;
    const token = `a${++this.undoSeq}`;
    this.undos.set(token, steps);
    for (const key of this.undos.keys()) if (this.undos.size > UNDOS_KEPT) this.undos.delete(key);
    return token;
  }

  /** The one way anything happens: only from a preview someone saw, and only what's still as they saw it (revisions 2, 10). */
  async apply(params: ParsedParamsOf<"ai.actionApply">, clientId: string): Promise<AiActionApplied> {
    const { store } = this.b;
    const ops = this.ops!;
    const p = this.held(params.previewId, clientId);
    if (p.scanning || p.check === "needed" || p.applying) throw new RpcError("BAD_REQUEST", L("errors.ai.actionNotReady"));
    const ruleOnly = savesRuleOnly(this.info(p));
    p.applying = true;
    const { plan } = p;
    const targets = this.rows(p).filter((id) => this.ticked(p, id));
    const included = new Set(p.includeSkipped ? p.skipped : []);
    const steps: UndoStep[] = [];
    const progress = progressReporter(this.b, params.jobId, targets.length);
    progress(0);
    let done = 0;
    let changed = 0;
    let spared = 0;
    let categoryId = targetCategory(plan) ?? null;
    let failed: unknown = null;
    let filterSaved = false;
    let filterFailed = false;
    // a slice counts as done once the next begins (or it all ended): one that fails was never done
    let pending = 0;
    const narrow: Narrow = async (chunk) => {
      done += pending;
      pending = 0;
      if (p.stop) return [];
      const facts = new Map((await store.filters.actionFacts(chunk, categoryId ?? undefined)).map((f) => [f.id, f]));
      const out: number[] = [];
      for (const id of chunk) {
        const f = facts.get(id);
        const stamp = p.stamps.get(id);
        if (!f || !stamp || f.lastDate !== stamp.lastDate || f.messageCount !== stamp.messageCount || !eligible(plan, f)) changed++;
        else if (spares(plan, f) && !included.has(id)) spared++;
        else out.push(id);
      }
      pending = out.length;
      return out;
    };
    try {
      const { action } = plan;
      if (action.type === "createCategory") {
        const list = await store.categories.list();
        const same = list.find((c) => c.name.toLowerCase() === action.name.toLowerCase());
        if (same) categoryId = same.id;
        else {
          const used = new Set(list.map((c) => c.color));
          const color = CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[list.length % CATEGORY_COLORS.length]!;
          // as a category made by hand is: its mail leaves the Inbox, and the preview said so
          const made = await store.categories.create(action.name, color, { showInInbox: false });
          categoryId = made.id;
          steps.push({ kind: "category", made });
          await ops.categoriesChanged();
        }
      }
      if (action.type === "moveToCategory" || action.type === "createCategory") {
        const moves: MoveStep[] = [];
        steps.push({ kind: "moves", steps: moves });
        let reached = 0;
        // a move for each slice, read again just before it (revision 10), and Stop falls between them (revision 12)
        await this.b.runBudgeted(targets, async (slice) => {
          await ops.toCategory(categoryId!, slice, narrow, (step) => {
            moves.push(step);
            done += pending;
            pending = 0;
          });
          progress((reached += slice.length));
        });
      } else {
        const run = action.type === "moveToFolder" ? (ids: number[]) => ops.toFolder(action.accountId, action.folder, ids, narrow, progress) : (ids: number[]) => ops.act(ids, action.type as "archive", narrow, progress);
        try {
          const r = await run(targets);
          if (r.undoId !== null) steps.push({ kind: "acts", undoId: r.undoId });
        } catch (error) {
          const undoId = error instanceof RpcError ? (error.details as { undoId?: unknown } | undefined)?.undoId : undefined;
          if (typeof undoId === "number") steps.push({ kind: "acts", undoId });
          throw error;
        }
      }
      done += pending;
      pending = 0;
      progress(targets.length);
      const { keep, conditions } = this.keep(p);
      if (params.future && keep.kind === "ok" && !p.stop) {
        // forwarding is read again: a rule a model wrote never sends mail anywhere (revision 1)
        const now = (await store.categories.list()).find((c) => c.id === categoryId);
        // or gone since the preview: with no rows, nothing else would have found that out
        if (now?.forward?.enabled || (categoryId !== null && !now)) filterFailed = true;
        else {
          try {
            const f = await ops.ensureFilter(this.ruleFor(plan, conditions, categoryId), capFilterName(plan.summary));
            filterSaved = true;
            if (f.filterUndo !== null) steps.push({ kind: "filter", filterUndo: f.filterUndo });
          } catch (error) {
            filterFailed = true;
            const partial = error instanceof RpcError ? (error.details as { filterUndo?: unknown } | undefined)?.filterUndo : undefined;
            if (typeof partial === "number") steps.push({ kind: "filter", filterUndo: partial });
            this.b.log("warn", "action filter failed", error instanceof Error ? error.name : "unknown");
          }
        }
      }
    } catch (error) {
      failed = error;
    }
    const committed = steps.some((s) => s.kind !== "moves" || s.steps.length > 0);
    const stopped = p.stop || failed !== null;
    this.drop(p);
    p.applying = false;
    // nothing committed: the failure as it is
    if (failed !== null && !committed) throw failed;
    if (failed !== null) this.b.log("warn", "action stopped partway", failed instanceof Error ? failed.name : "unknown");
    const conversationId = await this.remembered(p, done, stopped, ruleOnly ? (filterSaved ? "saved" : "failed") : null);
    return { undoToken: this.remember(steps), done, changed, spared, stopped, filterFailed, filterSaved, failed: failed !== null, conversationId };
  }

  /** A command in the history: the sentence, what it meant, what came of it. Never its rows. */
  private async remembered(p: Preview, done: number, stopped: boolean, ruleOnly: "saved" | "failed" | null): Promise<number | null> {
    const { store } = this.b;
    try {
      const { ai } = await this.b.ask.target();
      const outcome = ruleOnly ? L(ruleOnly === "saved" ? "action.rule.saved" : "action.rule.failed").message : L(`action.outcome.${p.plan.action.type === "createCategory" ? "moveToCategory" : p.plan.action.type}`, { count: done, category: p.categoryName ?? "" }).message;
      const written = await store.ask.history.add({
        conversationId: p.conversationId,
        kind: "command",
        question: p.sentence,
        answer: `${p.plan.summary}\n${stopped ? L("action.outcome.stopped", { outcome }).message : outcome}`,
        status: "answered",
        sources: [],
        queries: [],
        checks: { unlinked: false, unsupported: [] },
        accountIds: [...p.accounts],
        model: ai.model,
        provider: ai.providerId,
        promptVersion: ACTION_PROMPT_VERSION,
        now: this.b.now(),
        clearGeneration: p.clearGeneration,
      });
      return written?.conversationId ?? null;
    } catch (error) {
      // the mail moved: a history that couldn't be written costs nothing more
      this.b.log("warn", "action history failed", error instanceof Error ? error.name : "unknown");
      return null;
    }
  }

  /** Everything back, newest first. A step that fails stays for a retry; the ones after it haven't happened yet. */
  async undo(token: string, jobId: string | undefined): Promise<{ restored: number }> {
    const ops = this.ops!;
    const steps = this.undos.get(token);
    if (!steps) throw new RpcError("NOT_FOUND", L("errors.undoGone"));
    let restored = 0;
    while (steps.length) {
      const step = steps[steps.length - 1]!;
      if (step.kind === "filter") await ops.undoFilter(step.filterUndo);
      else if (step.kind === "acts") restored += await ops.undoActs(step.undoId, jobId);
      else if (step.kind === "moves") {
        while (step.steps.length) {
          restored += await ops.undoMove(step.steps[step.steps.length - 1]!);
          step.steps.pop();
        }
      } else await this.removeMade(step);
      steps.pop();
    }
    this.undos.delete(token);
    return { restored };
  }

  /** A category it made goes only if it's as it was made and empty: anything else is the user's now. */
  private async removeMade(step: Extract<UndoStep, { kind: "category" }>): Promise<void> {
    const { store } = this.b;
    const { made } = step;
    const c = (await store.categories.list()).find((x) => x.id === made.id);
    if (!c || c.name !== made.name || c.color !== made.color || c.showInInbox !== made.showInInbox || c.autoApply !== made.autoApply || c.forward) return;
    if (await store.categories.hasThreads(made.id)) return;
    if ((await store.filters.list()).some((f) => f.rule.actions.some((a) => a.type === "addCategory" && a.categoryId === made.id))) return;
    await store.categories.delete(made.id);
    await this.ops!.categoriesChanged();
  }
}

const dayIn = (ms: number, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};
