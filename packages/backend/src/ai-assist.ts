import { AiError, type AiTasks } from "@terno/ai";
import { captureError } from "@terno/core/diag";
import { candidateCategories, POLICY, reason, senderVetoed } from "@terno/core";
import type { MailStore } from "@terno/store";
import type { Categorizer } from "./categorizer";
import { readSettings } from "./settings";

export interface AiAssistHost {
  readonly store: MailStore;
  readonly categorizer: Categorizer;
  now(): number;
  ai(): Promise<AiTasks>;
  notifyChanged(threadIds: Iterable<number>, views?: boolean): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

/** The uncertain band the AI may look at; above it the engine is sure enough on its own. */
const BAND_LOW = 0.5;
const PER_MINUTE = 20;
const AI_MIN_CONFIDENCE = 0.7;

/**
 * Optional second opinion for threads the engine left undecided with
 * 0.5 ≤ p < 0.97. Off unless the user turns it on; runs only through the
 * configured provider (Backend.ai(), so the network policy and local mode
 * apply), outside ingestion slices, at most 20 calls a minute. Successful
 * responses run once per thread; failed tasks may be enqueued again.
 * It can only turn "nothing" into a suggestion: never auto-apply.
 */
export class AiAssist {
  private readonly queue: number[] = [];
  private readonly seen = new Set<number>();
  private readonly calls: number[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: AiAssistHost) {}

  get pending(): number {
    return this.queue.length;
  }

  async enqueue(threadIds: readonly number[]): Promise<void> {
    if (threadIds.length === 0 || !(await readSettings(this.host.store)).aiCategorize) return;
    for (const id of threadIds) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.queue.push(id);
    }
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.queue.length = 0;
  }

  private schedule(ms: number): void {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, ms);
    this.timer.unref?.();
  }

  /** Processes the queue within the rate limit; resolves when it has to wait or is empty. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const threadId = this.queue.shift()!;
        if (!(await readSettings(this.host.store)).aiCategorize) {
          this.queue.length = 0;
          break;
        }
        const r = await this.consider(threadId);
        if (r === "stop") {
          this.queue.length = 0;
          break;
        }
        if (r === "wait") {
          this.queue.unshift(threadId);
          this.running = false;
          this.schedule(60_000 - (Date.now() - this.calls[0]!));
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** The assist is on, the thread is new-mail-like (inbox, not spam/trash) and nobody decided on it. */
  private async allowed(threadId: number): Promise<boolean> {
    const settings = await readSettings(this.host.store);
    if (!settings.aiCategorize || settings.autoCategorize === "off") return false;
    return this.host.store.categorize.aiCandidate(threadId);
  }

  /** "stop" when the AI can't run at all (not configured, paused by local mode); "wait" at the rate limit. */
  private async consider(threadId: number): Promise<"done" | "wait" | "stop"> {
    const { store } = this.host;
    const model = this.host.categorizer.model;
    if (!model || !store.isOpen || !(await this.allowed(threadId))) return "done";
    const set = (await store.categorize.threadFeatures([threadId])).get(threadId);
    if (!set || model.lookAlike(set.encoded)) return "done";
    const scores = model.score(set.encoded);
    const decided = new Set(candidateCategories(scores));
    const vetoes = await store.categorize.vetoes(threadId, set.features.sender, scores.map((s) => s.categoryId), this.host.now());
    const band = scores.filter((s) => {
      const v = vetoes.get(s.categoryId);
      return s.p >= BAND_LOW && s.p < POLICY.autoP && !decided.has(s.categoryId) && s.positives >= POLICY.suggestMinPositives && !v?.hard && !(v && senderVetoed(v));
    });
    if (band.length === 0) return "done";
    const names = new Map((await store.categories.list()).map((c) => [c.id, c.name]));
    const labels = band.map((s) => names.get(s.categoryId)).filter((n): n is string => !!n);
    const now = Date.now();
    while (this.calls.length && now - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= PER_MINUTE) return "wait";
    this.calls.push(now);
    let ai: AiTasks;
    try {
      ai = await this.host.ai();
    } catch (error) {
      this.host.log("info", "categorization assist skipped", error instanceof Error ? error.message : error);
      return "stop";
    }
    try {
      const { source } = set.root;
      // what a person sees in the list: sender, subject and the start of the text
      const text = `De: ${source.fromName} <${source.fromEmail}>\nAsunto: ${source.subject}\n${(source.bodyText ?? "").slice(0, 600)}`;
      const [r] = await ai.classify({
        items: [{ id: String(threadId), text }],
        labels,
        instructions: "The labels are the user's mail categories. Answer null unless the message clearly belongs to one.",
      });
      if (!r?.label || r.confidence < AI_MIN_CONFIDENCE) return "done";
      const score = band.find((s) => names.get(s.categoryId) === r.label);
      if (!score || !store.isOpen) return "done";
      // the provider took a while: the user, the settings or the model may have spoken since
      const settings = await readSettings(store);
      const current = this.host.categorizer.model;
      if (!settings.aiCategorize || settings.autoCategorize === "off" || !current) return "done";
      const wrote = await store.categorize.recordAiSuggestion({
        threadId,
        categoryId: score.categoryId,
        p: score.p,
        explain: [ai.local ? reason("reason.aiLocal", { category: r.label }) : reason("reason.aiCloud", { provider: ai.providerId, category: r.label })],
        sender: set.features.sender,
        encoded: set.encoded,
        model: current,
        now: this.host.now(),
      });
      if (wrote) this.host.notifyChanged([threadId], false);
    } catch (error) {
      // Leave failed work eligible for a later enqueue, without scheduling retries.
      this.seen.delete(threadId);
      // an AiError is the provider's verdict (expected); anything else is ours
      captureError(error, { code: "ai.assist_failed", fields: { aiKind: error instanceof AiError ? error.kind : "other" } });
      this.host.log("warn", "categorization assist failed", { aiKind: error instanceof AiError ? error.kind : "other" });
    }
    return "done";
  }
}
