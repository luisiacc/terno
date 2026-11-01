import { RpcError } from "@terno/core/rpc";
import type { FolderView } from "@terno/core";
import { L } from "@terno/i18n";
import { mboxMessage, type MboxBody, type MboxStats } from "@terno/mail/portable";
import type { ExportMessage, FolderExportCursor, FolderExportTarget } from "@terno/store";
import { BULK_SLICE, SliceSizer } from "./slicer";
import type { BackendCore } from "./core";
import { renameAliases } from "./folders";

/**
 * Plan 107: an .mbox of a folder's messages, from this computer's copy, as a session. `start` fixes the messages
 * once (read a stretch of threads at a time, then sorted by date and id); each `next` writes the following text,
 * up to ~1 MB or ~15 ms of work, resuming a message (a large attachment) where the last one stopped. A message
 * deleted meanwhile is skipped; one that arrived after `start` isn't in it. One session per renderer client (a new
 * start ends the last), and one left alone for a minute ends by itself. Nothing goes to the network.
 */

/** What one `next` may work (the bulk slicer's budget). */
const NEXT_MS = BULK_SLICE.targetMs;
/** Id reads: a stretch of threads and messages looked at a slice, sized by time. */
const IDS_SLICE = { ...BULK_SLICE, initial: 200, floor: 20, ceiling: 5000 };
/** What one `next` writes, at most (a piece may take it a little past: pieces are ≤ MBOX_PIECE). */
export const EXPORT_TEXT_MAX = 1024 * 1024;
export const EXPORT_IDLE_MS = 60_000;

interface Session {
  id: string;
  clientId: string;
  /** message ids by (date, id) */
  ids: Float64Array;
  /** the next id to read */
  at: number;
  /** the message being written */
  current: AsyncGenerator<string, MboxStats> | null;
  done: number;
  missingAttachments: number;
  partialBodies: number;
  busy: boolean;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FolderExports {
  private readonly sessions = new Map<string, Session>();
  /** a client's start in progress (a newer one supersedes it) */
  private readonly starting = new Map<string, number>();
  private seq = 0;

  constructor(private readonly b: BackendCore) {}

  /** how many sessions are open (tests) */
  get size(): number {
    return this.sessions.size;
  }

  async start(target: FolderExportTarget, clientId: string): Promise<{ exportId: string; total: number; name: string }> {
    // one per client: the last one ends now, and a start still resolving ids gives way
    for (const s of this.sessions.values()) if (s.clientId === clientId) this.end(s);
    const ticket = ++this.seq;
    this.starting.set(clientId, ticket);
    const superseded = () => this.starting.get(clientId) !== ticket || this.b.isStopped;
    try {
      const name = await this.nameOf(target);
      // a folder renamed here that no pass has read keeps its mail under its old path meanwhile (Codex code review round 5 #2)
      let place: FolderExportTarget = target;
      if (target.folder !== undefined) {
        const { aliases, except } = await renameAliases(this.b, target.accountId, [target.folder]);
        place = { ...target, aliases, except: except.get(target.folder) ?? [] };
      }
      const { ids, dates } = await this.resolve(place, superseded);
      if (superseded()) throw new RpcError("CANCELLED", L("errors.folderExport.cancelled"));
      const sorted = await sortByDate(ids, dates, () => this.b.yieldTurn());
      // the sort takes turns: a newer start meanwhile wins (Codex code review round 4 #5: both were kept)
      if (superseded()) throw new RpcError("CANCELLED", L("errors.folderExport.cancelled"));
      const session: Session = { id: `export-${ticket}-${Math.random().toString(36).slice(2, 10)}`, clientId, ids: sorted, at: 0, current: null, done: 0, missingAttachments: 0, partialBodies: 0, busy: false, ended: false, timer: null };
      this.sessions.set(session.id, session);
      this.touch(session);
      return { exportId: session.id, total: session.ids.length, name };
    } finally {
      if (this.starting.get(clientId) === ticket) this.starting.delete(clientId);
    }
  }

  async next(exportId: string, clientId: string): Promise<{ text: string; done: number; total: number; finished: boolean; missingAttachments: number; partialBodies: number }> {
    const s = this.session(exportId, clientId);
    if (s.busy) throw new RpcError("UNAVAILABLE", L("errors.folderExport.busy"));
    s.busy = true;
    if (s.timer) clearTimeout(s.timer);
    try {
      const started = performance.now();
      const pieces: string[] = [];
      let size = 0;
      while (!s.ended && size < EXPORT_TEXT_MAX && (pieces.length === 0 || performance.now() - started < NEXT_MS)) {
        if (!s.current) {
          const m = await this.nextMessage(s, started);
          if (!m) break;
          s.current = mboxMessage(this.toMbox(m), (attachment, index) => this.chunk(m, attachment, index));
        }
        const r = await s.current.next();
        if (r.done) {
          s.current = null;
          s.done++;
          s.missingAttachments += r.value.missingAttachments;
          if (r.value.partialBody) s.partialBodies++;
        } else {
          pieces.push(r.value);
          size += r.value.length;
        }
      }
      if (s.ended) throw new RpcError("CANCELLED", L("errors.folderExport.cancelled"));
      const finished = !s.current && s.at >= s.ids.length;
      const out = { text: pieces.join(""), done: s.done, total: s.ids.length, finished, missingAttachments: s.missingAttachments, partialBodies: s.partialBodies };
      if (finished) this.end(s);
      return out;
    } catch (error) {
      // a failure ends it: the renderer says so and drops what it wrote
      this.end(s);
      throw error;
    } finally {
      s.busy = false;
      if (!s.ended) this.touch(s);
    }
  }

  cancel(exportId: string, clientId: string): { ok: true } {
    const s = this.sessions.get(exportId);
    if (s && s.clientId === clientId) this.end(s);
    return { ok: true };
  }

  private session(exportId: string, clientId: string): Session {
    const s = this.sessions.get(exportId);
    if (!s || s.clientId !== clientId) throw new RpcError("NOT_FOUND", L("errors.folderExport.expired"));
    return s;
  }

  private touch(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => this.end(s), EXPORT_IDLE_MS);
    (s.timer as { unref?: () => void }).unref?.();
  }

  private end(s: Session): void {
    s.ended = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    // a message half written lets go of what it holds
    void s.current?.return({ missingAttachments: 0, partialBody: false }).catch(() => {});
    s.current = null;
    this.sessions.delete(s.id);
  }

  private async nameOf(target: FolderExportTarget): Promise<string> {
    if (!(await this.b.store.accounts.get(target.accountId))) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
    if (target.view !== undefined) return L(`view.${target.view}` as `view.${FolderView}`).message;
    const folder = (await this.b.store.folders.list()).find((f) => f.accountId === target.accountId && f.key === target.folder);
    if (!folder) throw new RpcError("NOT_FOUND", L("errors.folderExport.gone"));
    return folder.path.at(-1) || folder.key;
  }

  /** every message id of the place, a stretch a slice (of threads, or of one long conversation) with a turn between */
  private async resolve(target: FolderExportTarget, superseded: () => boolean): Promise<{ ids: number[]; dates: number[] }> {
    const sizer = new SliceSizer(IDS_SLICE);
    const ids: number[] = [];
    const dates: number[] = [];
    for (let after: FolderExportCursor | null = null; !superseded(); ) {
      const started = performance.now();
      const r = await this.b.store.folderExport.ids(target, after, sizer.size);
      sizer.record(sizer.size, performance.now() - started);
      for (const m of r.messages) {
        ids.push(m.id);
        dates.push(m.date);
      }
      if (r.next === null) break;
      after = r.next;
      await this.b.yieldTurn();
    }
    return { ids, dates };
  }

  /**
   * the next message still here (gone ones are skipped), read as its writing begins: one read ahead could be deleted
   * while the one before it was still being written, and was exported anyway (Codex code review round 2 #7). Null:
   * none left, or the call's time went on gone ones (the next call goes on).
   */
  private async nextMessage(s: Session, started: number): Promise<ExportMessage | null> {
    while (s.at < s.ids.length && performance.now() - started < NEXT_MS) {
      const [m] = await this.b.store.folderExport.messages([s.ids[s.at++]!]);
      if (s.ended) return null;
      if (m) return m;
    }
    return null;
  }

  /** its bodies read a stretch at a time as they're written, never whole (Codex code review round 6 #4) */
  private toMbox(m: ExportMessage) {
    const body = (part: "text" | "html"): MboxBody => (at, size) => this.b.store.folderExport.body(m.id, part, at, size);
    return { ...m, bodyText: m.hasText ? body("text") : null, bodyHtml: m.hasHtml ? body("html") : null, partial: m.bodyState !== "full", attachments: m.attachments.map((a) => ({ ...a, stored: a.assetId !== null })) };
  }

  private async chunk(m: ExportMessage, attachment: number, index: number): Promise<string | null> {
    const assetId = m.attachments[attachment]?.assetId;
    if (!assetId) return null;
    // removed meanwhile (the message went, its asset collected): it's missing, not a failure
    return this.b.store.attachments.read(m.accountId, assetId, index).catch(() => null);
  }
}

/**
 * Ids by (date, id): runs sorted natively a block at a time, then merged pass by pass with a turn whenever a
 * slice's worth of time went (50k ids never sort in one go). The time is looked at every `STEP` places, inside a
 * merge and while the order and the result are written (Codex code review round 9 #4: a million ids' last merge and
 * the result's build were one ~56 ms segment).
 */
export async function sortByDate(ids: readonly number[], dates: readonly number[], yieldTo: () => Promise<void>, sliceMs = 8): Promise<Float64Array> {
  const n = ids.length;
  const less = (a: number, b: number) => dates[a]! < dates[b]! || (dates[a] === dates[b] && ids[a]! < ids[b]!);
  const STEP = 4096;
  let started = performance.now();
  const turn = async () => {
    if (performance.now() - started < sliceMs) return;
    await yieldTo();
    started = performance.now();
  };
  let order = new Uint32Array(n);
  let spare = new Uint32Array(n);
  for (let lo = 0; lo < n; lo += STEP) {
    for (let i = lo, end = Math.min(n, lo + STEP); i < end; i++) order[i] = i;
    await turn();
  }
  const RUN = 2048;
  for (let lo = 0; lo < n; lo += RUN) {
    const run = Array.from(order.subarray(lo, Math.min(n, lo + RUN))).sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
    order.set(run, lo);
    await turn();
  }
  for (let width = RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(n, lo + width);
      const hi = Math.min(n, lo + 2 * width);
      let i = lo;
      let j = mid;
      let k = lo;
      while (k < hi) {
        // a stretch of the merge, then the time looked at
        for (const end = Math.min(hi, k + STEP); k < end; ) {
          if (i < mid && (j >= hi || !less(order[j]!, order[i]!))) spare[k++] = order[i++]!;
          else spare[k++] = order[j++]!;
        }
        await turn();
      }
    }
    [order, spare] = [spare, order];
  }
  const out = new Float64Array(n);
  for (let lo = 0; lo < n; lo += STEP) {
    for (let i = lo, end = Math.min(n, lo + STEP); i < end; i++) out[i] = ids[order[i]!]!;
    await turn();
  }
  return out;
}
