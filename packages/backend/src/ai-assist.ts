import type { AiTasks } from "@unica/ai";
import { candidateCategories, POLICY } from "@unica/core";
import { threadFeatures, type Db } from "@unica/db";
import type { Categorizer } from "./categorizer";
import { readSettings } from "./settings";

export interface AiAssistHost {
  readonly db: Db;
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
 * apply), outside ingestion slices, at most 20 calls a minute, once per
 * thread. It can only turn "nothing" into a suggestion: never auto-apply.
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

  enqueue(threadIds: readonly number[]): void {
    if (threadIds.length === 0 || !readSettings(this.host.db).aiCategorize) return;
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
        if (!readSettings(this.host.db).aiCategorize) {
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

  /** "stop" when the AI can't run at all (not configured, paused by local mode); "wait" at the rate limit. */
  private async consider(threadId: number): Promise<"done" | "wait" | "stop"> {
    const { db } = this.host;
    const model = this.host.categorizer.model;
    if (!model || !db.raw.isOpen) return "done";
    if (db.get("SELECT 1 FROM thread_categories WHERE thread_id = ?1 UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ?1 LIMIT 1", threadId)) return "done";
    const set = threadFeatures(db, [threadId]).get(threadId);
    if (!set) return "done";
    const scores = model.score(set.encoded);
    const decided = new Set(candidateCategories(scores));
    const band = scores.filter((s) => s.p >= BAND_LOW && s.p < POLICY.autoP && !decided.has(s.categoryId) && s.positives >= POLICY.suggestMinPositives);
    if (band.length === 0) return "done";
    const names = new Map(db.all<{ id: number; name: string }>("SELECT id, name FROM categories").map((c) => [c.id, c.name]));
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
      if (!score || !db.raw.isOpen) return "done";
      const wrote = db.tx(() => {
        if (db.get("SELECT 1 FROM thread_categories WHERE thread_id = ?1 UNION ALL SELECT 1 FROM cls_decisions WHERE thread_id = ?1 LIMIT 1", threadId)) return false;
        db.run(
          "INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', ?, ?, ?)",
          threadId,
          score.categoryId,
          score.p,
          JSON.stringify([`la IA (${ai.local ? "en este Mac" : ai.providerId}) cree que es de ${r.label}`]),
          this.host.now(),
        );
        return true;
      });
      if (wrote) this.host.notifyChanged([threadId], false);
    } catch (error) {
      this.host.log("warn", "categorization assist failed", error instanceof Error ? error.message : error);
    }
    return "done";
  }
}
