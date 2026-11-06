import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { AiError, REPLY_PROMPT_VERSION, type AiTasks } from "@terno/ai";
import { WAITING_WINDOW_MS, type AiErrorKind, type AiPrepareReply, type AiReplyEvent, type PreparedReply, type ReplyState, type WritingUsed } from "@terno/core";
import { RpcError, type ParsedParamsOf } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { summaryBlocked } from "@terno/store";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";
import { withoutQuotes } from "./summaries";
import { readPrefs } from "./writing";

/**
 * Plan 144: a reply prepared when a conversation that waits for one is opened, and only then. The switch is the
 * consent; nothing here ever sends anything, and what it writes isn't a draft until someone uses it. It's automatic
 * spending, so it charges its own task and keeps to its limits. Nothing this file logs carries mail.
 */

/** Nobody asked for this one: it answers, but what only they can decide stays theirs, as a [placeholder] (the panel's R1, R2). */
const PREPARED_INSTRUCTION = "Answer what the thread needs, as far as the mail lets you. Don't accept, decline, agree to or commit to anything they haven't already said in this thread: a call, a price, a date, a yes or a no. Leave that decision as a [placeholder]. Say nothing they haven't: no apology of your own. Keep the form of address they use in this thread, tú or usted.";

type Prepare = ParsedParamsOf<"ai.prepareReply">;
type Act = ParsedParamsOf<"ai.replyAct">;

interface Running {
  threadId: number;
  listeners: Set<string>;
  controller: AbortController;
  text: string;
  /** paid for from here on: leaving no longer stops it */
  firstWord: boolean;
  /** Stop or a change of settings: nothing it finishes is kept */
  dropped: boolean;
  /** Stop said not to come back */
  dismissed: boolean;
  /** what's being read for it, as it was at the start */
  stamp: string | null;
}

export class ReplyService {
  /** one preparation a thread, claimed before anything awaits (revision 5) */
  private readonly running = new Map<number, Running>();
  private blockedBy: { kind: AiErrorKind } | null = null;

  constructor(private readonly b: Backend) {}

  status(): { blockedBy: { kind: AiErrorKind } | null } {
    return { blockedBy: this.blockedBy };
  }

  /** Called as any request of this task is about to leave, after its wait: whatever no longer holds stops there. */
  async holdingUp(): Promise<void> {
    for (const entry of this.running.values()) {
      if (entry.stamp === null || entry.controller.signal.aborted) continue;
      if (!(await this.eligible(entry.threadId, entry.stamp))) {
        entry.dropped = true;
        entry.controller.abort();
      }
    }
  }

  private emit(entry: Running, event: AiReplyEvent): void {
    for (const client of entry.listeners) this.b.server.emitTo(client, "aiReply", event);
  }

  /** Before every request, and at the start: the renderer's word isn't enough, and things move during a check (revision 3). */
  private async eligible(threadId: number, stamp?: string): Promise<{ stamp: string } | null> {
    const { store } = this.b;
    const settings = await readSettings(store);
    if (!settings.replies?.enabled || !(await this.notMuted(threadId))) return null;
    const [summary] = await store.threads.summaries([threadId]);
    if (!summary || summary.waitingSince === null || summary.waitingSince === undefined) return null;
    if (this.b.now() - summary.waitingSince > WAITING_WINDOW_MS) return null;
    if (summary.inSpam || summary.inTrash || (!summary.inInbox && !summary.categoryIds.length)) return null;
    if ((await store.drafts.list()).some((d) => d.thread_id === threadId)) return null;
    const sources = await store.aiSummaries.sources(threadId);
    if (!sources || summaryBlocked(sources)) return null;
    if (stamp !== undefined && sources.stamp !== stamp) return null;
    return { stamp: sources.stamp };
  }

  private async notMuted(threadId: number): Promise<boolean> {
    const { store } = this.b;
    const accountId = (await store.threads.summaries([threadId]))[0]?.accountId;
    if (accountId === undefined) return false;
    const prefs = await readPrefs(store);
    return prefs.global.enabled && prefs.accounts[String(accountId)]?.prepareReplies !== false;
  }

  private composeParams(p: Pick<Prepare, "threadId" | "accountId" | "to" | "cc" | "answeringMessageId" | "timezone">): ParsedParamsOf<"ai.compose"> {
    return { requestId: "prepared", session: `prepared-${p.threadId}`, accountId: p.accountId, kind: "reply", threadId: p.threadId, ...(p.answeringMessageId !== undefined ? { answeringMessageId: p.answeringMessageId } : {}), to: p.to, cc: p.cc, subject: "", needsSubject: false, instruction: PREPARED_INSTRUCTION, timezone: p.timezone } as ParsedParamsOf<"ai.compose">;
  }

  /** The answered message is the newest inbound, which the stamp already holds: asked for the same way at both ends. */
  private async generationKey(p: Pick<Prepare, "threadId" | "accountId" | "to" | "cc" | "answeringMessageId" | "timezone">, ai: AiTasks): Promise<{ key: string; waiting: number | null }> {
    const { store } = this.b;
    const account = await store.accounts.get(p.accountId);
    if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    return this.b.writing.snapshotKey(this.composeParams(p), ai, account, await readPrefs(store));
  }

  async prepare(p: Prepare, clientId: string): Promise<AiPrepareReply> {
    const held = this.running.get(p.threadId);
    if (held) {
      // another window, or an open again: it joins, and it pays nothing
      held.listeners.add(clientId);
      if (held.text) this.b.server.emitTo(clientId, "aiReply", { threadId: p.threadId, phase: "writing", text: held.text });
      return { status: "started" };
    }
    const entry: Running = { threadId: p.threadId, listeners: new Set([clientId]), controller: new AbortController(), text: "", firstWord: false, dropped: false, dismissed: false, stamp: null };
    this.running.set(p.threadId, entry);
    let going = false;
    try {
      if (this.blockedBy?.kind === "auth") return { status: "none" };
      const clearGeneration = this.b.store.replies.clearGeneration();
      const now = await this.eligible(p.threadId);
      if (!now) {
        // a reply ready at this state still shows when the switch is on, and nothing runs
        return { status: "none" };
      }
      const stored = await this.b.store.replies.get(p.threadId);
      const ai = await this.b.aiService.forTask("reply");
      const { key, waiting } = await this.generationKey(p, ai);
      if (stored?.sourceStamp === now.stamp) {
        if (stored.state === "ready" && stored.generationKey === key && stored.body) return { status: "ready", row: stored };
        // whatever was decided at this state stands, and reopening costs nothing
        if (stored.state !== "ready") return { status: "none" };
      }
      if (waiting !== null) return { status: "waitingBody", messageId: waiting };
      going = true;
      entry.stamp = now.stamp;
      void this.run(entry, p, { ai, key, stamp: now.stamp, clearGeneration, prior: stored ? { rowId: stored.rowId, revision: stored.revision } : null }).finally(() => {
        if (this.running.get(p.threadId) === entry) this.running.delete(p.threadId);
      });
      return { status: "started" };
    } catch (error) {
      // nobody asked: a key that isn't set up shows nothing here, and Settings says why
      if (error instanceof AiError) {
        this.noteFailure(error);
        return { status: "none" };
      }
      throw error;
    } finally {
      if (!going && this.running.get(p.threadId) === entry) this.running.delete(p.threadId);
    }
  }

  private noteFailure(error: unknown): void {
    if (error instanceof AiError && error.kind !== "cancelled") this.blockedBy = { kind: error.kind };
  }

  private async run(entry: Running, p: Prepare, o: { ai: AiTasks; key: string; stamp: string; clearGeneration: number; prior: { rowId: string; revision: number } | null }): Promise<void> {
    const { store } = this.b;
    const { threadId } = p;
    // a revoked permission to use sent mail, or drafting off, stops this as it stops a person's draft (⌘J)
    const { signal: permitted, done: permissionDone } = this.b.writing.underPermission(p.accountId, entry.controller.signal);
    const signalAll = AbortSignal.any([permitted, this.b.abort.signal]);
    const answering = { id: 0 };
    const write = async (state: ReplyState, body: string | null, extra: { used?: WritingUsed; checks?: PreparedReply["checks"] } = {}): Promise<PreparedReply | null> => {
      if ((entry.dropped || permitted.aborted) && !entry.dismissed) return null;
      const finished = await store.replies.finish({ rowId: globalThis.crypto.randomUUID(), expect: o.prior, threadId, sourceStamp: o.stamp, generationKey: o.key, answeringMessageId: answering.id, state: entry.dismissed ? "dismissed" : state, body, used: extra.used ?? null, checks: extra.checks ?? null, to: p.to, cc: p.cc, model: o.ai.model, provider: o.ai.providerId, promptVersion: REPLY_PROMPT_VERSION, generatedAt: this.b.now(), clearGeneration: o.clearGeneration });
      return finished === "written" ? store.replies.get(threadId) : null;
    };
    try {
      const context = await store.writing.threadContext(threadId, { maxBodies: 2, maxChars: 4000 });
      const newest = context ? [...context.messages].reverse().find((m) => !m.own) : undefined;
      if (!context || !newest?.text) return this.emit(entry, { threadId, phase: "none" });
      answering.id = newest.id;
      const yours = [...context.messages].reverse().find((m) => m.own)?.text;
      const checker = await this.b.aiService.forTask("replyCheck");
      if (!(await this.eligible(threadId, o.stamp))) return this.emit(entry, { threadId, phase: "none" });
      const wanted = await checker.needsReply({ from: newest.fromName ? `${newest.fromName} <${newest.fromEmail}>` : newest.fromEmail, subject: context.subject, newest: withoutQuotes(newest.text), ...(yours ? { lastFromYou: withoutQuotes(yours) } : {}) }, signalAll);
      if (!wanted) {
        await write("skipped", null);
        return this.emit(entry, { threadId, phase: "none" });
      }
      if (!(await this.eligible(threadId, o.stamp))) return this.emit(entry, { threadId, phase: "none" });
      this.emit(entry, { threadId, phase: "writing", text: "" });
      let held = "";
      let last = 0;
      const send = () => {
        if (!held) return;
        entry.text += held;
        held = "";
        last = performance.now();
        this.emit(entry, { threadId, phase: "writing", text: entry.text });
      };
      const result = await this.b.writing.generate(this.composeParams({ ...p, answeringMessageId: newest.id }), [...entry.listeners][0] ?? "", {
        ai: o.ai,
        signal: signalAll,
        onDelta: (text) => {
          entry.firstWord = true;
          held += text;
          if (performance.now() - last > 30) send();
        },
        flush: send,
      });
      if (result.status !== "done") return this.emit(entry, { threadId, phase: "none" });
      const row = await write("ready", result.text, { used: result.used, checks: result.checks });
      this.blockedBy = null;
      // a new message or a clear meanwhile: gone, and the next open starts over
      this.emit(entry, row && row.state === "ready" ? { threadId, phase: "ready", row } : { threadId, phase: "none" });
    } catch (error) {
      // past a limit: no block and no row, so tomorrow it can run, and ⌘J still works
      const limited = error instanceof DailyLimitError || error instanceof MonthlyLimitError;
      if (entry.dismissed) await write("dismissed", null).catch(() => null);
      // plan 150: nothing set up isn't a verdict on this thread: no row, so it can run once something is
      else if (!entry.dropped && !limited && !(error instanceof AiError && (error.kind === "cancelled" || error.kind === "not_configured"))) {
        // "no retry" survives a restart, until the thread changes (revision 8)
        await write("failed", null).catch(() => null);
      }
      this.noteFailure(error);
      this.emit(entry, { threadId, phase: "none" });
    } finally {
      permissionDone();
    }
  }

  leave(threadId: number, clientId: string): void {
    const entry = this.running.get(threadId);
    if (!entry) return;
    entry.listeners.delete(clientId);
    if (!entry.listeners.size && !entry.firstWord) {
      entry.dropped = true;
      entry.controller.abort();
    }
  }

  disconnected(clientId: string): void {
    for (const entry of this.running.values()) this.leave(entry.threadId, clientId);
  }

  /** Stop, or ⌘J and `r` asking for something else. Nothing of it is kept; Stop's dismissal keeps it from coming back. */
  async stop(threadId: number, dismiss: boolean, clientId: string): Promise<void> {
    const entry = this.running.get(threadId);
    if (!entry || !entry.listeners.has(clientId)) return;
    entry.dropped = true;
    entry.dismissed = dismiss;
    entry.controller.abort();
  }

  /** A new key: a pause for the old one lifts, and what's underway goes on. */
  credentialsChanged(): void {
    this.blockedBy = null;
  }

  /** The provider moved, the switch went off: what's underway stops, writes nothing, and a pause lifts. */
  settingsChanged(): void {
    this.blockedBy = null;
    for (const entry of this.running.values()) {
      entry.dropped = true;
      entry.controller.abort();
    }
  }

  async clear(): Promise<void> {
    this.settingsChanged();
    await this.b.store.replies.clear();
    this.b.server.emit("aiReply", { threadId: 0, phase: "cleared" }, { origins: ["renderer", "dev"] });
  }

  /** Each only from the state it saw. Use also holds to the same thread, the same people and the same settings (revision 7). */
  async act(p: Act): Promise<PreparedReply | null> {
    const { store } = this.b;
    const row = await store.replies.get(p.threadId);
    if (!row || row.rowId !== p.rowId || row.revision !== p.revision) return null;
    const from = { rowId: row.rowId, state: row.state, revision: row.revision };
    switch (p.action) {
      case "use": {
        if (row.state !== "ready" || !row.body) return null;
        const sources = await store.aiSummaries.sources(p.threadId);
        if (!sources || summaryBlocked(sources) || sources.stamp !== row.sourceStamp) return null;
        const accountId = (await store.threads.summaries([p.threadId]))[0]?.accountId;
        if (accountId === undefined) return null;
        const ai = await this.b.aiService.forTask("reply").catch(() => null);
        if (!ai) return null;
        const { key } = await this.generationKey({ threadId: p.threadId, accountId, to: p.to, cc: p.cc, timezone: p.timezone }, ai);
        if (key !== row.generationKey) return null;
        return store.replies.transition(p.threadId, from, "used");
      }
      case "restore":
        return row.state === "used" ? store.replies.transition(p.threadId, from, "ready") : null;
      case "dismiss":
        return row.state === "ready" ? store.replies.transition(p.threadId, from, "dismissed") : null;
      case "undismiss":
        return row.state === "dismissed" && row.body ? store.replies.transition(p.threadId, from, "ready") : null;
    }
  }
}
