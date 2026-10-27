export interface FlushTarget {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface DraftFlush {
  id: number;
  saved: Promise<boolean>;
  current(): boolean;
  release(): void;
  commit(): void;
  restore(): void;
}

interface Document {
  epoch: number;
  commits: number;
  loading: boolean;
  token: string | null;
}

/** Each owner settles its own requests; navigation never unlocks another owner's lease. */
export class DraftFlushRequests {
  private sequence = 0;
  private documents = new Map<number, Document>();
  private requests = new Map<number, { target: FlushTarget; epoch: number; token: string; answer(saved: boolean): void; forget(): void }>();

  private document(target: FlushTarget): Document {
    let doc = this.documents.get(target.id);
    if (!doc) this.documents.set(target.id, (doc = { epoch: 0, commits: 0, loading: false, token: null }));
    return doc;
  }

  ready(target: FlushTarget, token: unknown): void {
    if (typeof token !== "string" || !token || token.length > 128 || target.isDestroyed()) return;
    const doc = this.document(target);
    if (doc.loading) return;
    if (doc.token && doc.token !== token) this.navigating(target);
    doc.loading = false;
    doc.token = token;
  }

  isReady(target: FlushTarget): boolean { const doc = this.documents.get(target.id); return !target.isDestroyed() && Boolean(doc?.token) && !doc?.loading; }

  navigating(target: FlushTarget): void {
    const doc = this.document(target);
    doc.epoch++; doc.loading = true;
    for (const request of this.requests.values()) if (request.target === target) request.answer(false);
  }

  committed(target: FlushTarget): void { const doc = this.document(target); doc.commits++; doc.loading = false; doc.token = null; }

  /** Called only after synchronously stopping a DevTools provisional reload. */
  resumeStopped(target: FlushTarget): boolean {
    const doc = this.documents.get(target.id);
    if (target.isDestroyed() || !doc?.token) return false;
    doc.loading = false; return true;
  }

  destroyed(target: FlushTarget): void {
    for (const request of this.requests.values()) if (request.target === target) { request.answer(false); request.forget(); }
    this.documents.delete(target.id);
  }

  answer(target: FlushTarget, id: unknown, saved: unknown, token: unknown): void {
    if (!Number.isSafeInteger(id)) return;
    const request = this.requests.get(id as number), doc = this.documents.get(target.id);
    if (request?.target === target && !doc?.loading && doc?.epoch === request.epoch && doc.token === request.token && token === request.token) request.answer(saved === true);
  }

  request(target: FlushTarget, hold: boolean): DraftFlush {
    const id = ++this.sequence, doc = this.document(target), epoch = doc.epoch, commits = doc.commits, token = doc.token;
    let answer!: (saved: boolean) => void, released = false;
    const saved = new Promise<boolean>((resolve) => { answer = resolve; });
    const forget = () => { this.requests.delete(id); answer(false); };
    const current = () => !target.isDestroyed() && this.documents.get(target.id) === doc && !doc.loading && doc.epoch === epoch && doc.token === token;
    const release = () => {
      forget();
      if (released) return;
      released = true;
      if (hold && token && !target.isDestroyed()) target.send("terno:flush-release", id, token);
    };
    const lease = { id, saved, current, release, commit: forget, restore: () => {
      if (!target.isDestroyed() && this.documents.get(target.id) === doc && doc.commits === commits) { doc.loading = false; doc.token = token; }
    } };
    if (!token || doc.loading || target.isDestroyed()) { answer(false); return lease; }
    this.requests.set(id, { target, epoch, token, answer, forget });
    try { target.send("terno:flush-drafts", id, hold, token); }
    catch { release(); }
    return lease;
  }
}
