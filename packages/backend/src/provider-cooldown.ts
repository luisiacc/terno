import { ProviderCooldownError, RequestNotDispatchedError, type ProviderRequests, type RequestDescriptor, type RequestTicket, type Observation429 } from "@terno/mail/portable";
import { COOLDOWN_CANDIDATE_BYTES, COOLDOWN_TICKETS, COOLDOWN_LEDGER_BYTES, COOLDOWN_SERVICES, PROVIDER_COOLDOWN_KEY, compactCooldown, decodeCooldown, encodeCooldown, mergeCooldownRows, mailboxKeyValid, mailboxDigest, nextCooldownRevision, copyOpAdmission, type CooldownLedger, type CooldownRow, type CooldownService, type CooldownStamp, type OAuthServices, type ProviderCooldownStore, type OpAdmission, type KindAdmission, OAUTH_SERVICES } from "@terno/store";
import { RETRY_DELAYS_MS, retryJitter } from "./connectivity";
import { isOAuthKind, type OAuthKind } from "@terno/core";
export { ProviderCooldownError, PROVIDER_COOLDOWN_KEY };
export type CooldownPersistence = Pick<ProviderCooldownStore, "read" | "update">;
export interface CooldownClock { wallNow(): number; elapsedNow(): number; random(): number }
type Timer = ReturnType<typeof setTimeout>;
export interface CooldownHooks {
  changed?(): void;
  setTimeout?(fn: () => void, ms: number): Timer;
  clearTimeout?(timer: Timer): void;
  /** false: a clock hold waits for an explicit Check clock or a start (plan 62's contract tests); plan 264 repairs it */
  repairClock?: boolean;
  /** plan 264: the ledger first read by a recovery (the start's read failed): what a start does on load runs now */
  loaded?(): void;
}
export type CooldownState =
  | { readonly kind: "ready" }
  | { readonly kind: "at"; readonly atMs: number }
  | { readonly kind: "hold"; readonly reason: "clock" | "clock-evidence" | "range" | "calendar" | "leap-second" | "storage" | "overflow" | "closed" };
interface Anchor { wall: number; elapsed: number; lastWall: number; lastElapsed: number }
interface Reservation {
  key: string;
  row?: CooldownRow;
  started: boolean;
  issued: boolean;
  observed: boolean;
  released: boolean;
  revision: string;
  notify?: (result: "committed" | "unconfirmed") => void;
  timer?: Timer;
}
const epoch = (n: number) => Number.isSafeInteger(n) && Math.abs(n) <= 8_640_000_000_000_000;
const elapsedValid = (n: number) => Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const keyOf = (owner: string, service: CooldownService) => `${owner}/${service}`;
const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;
const larger = (a: string | null, b: string | null) => a === null ? b : b === null ? a : BigInt(a) >= BigInt(b) ? a : b;
/** plan 264: a faulted store is read again after these (the last repeats) until it confirms; nothing while healthy */
export const COOLDOWN_RECOVERY_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const;
/** plan 264: a pause met at the anchor's last reading (a clock that then reads earlier can't unmeet it) */
const met = (row: CooldownRow, anchor: Anchor) => row.minimum !== null && epoch(anchor.lastWall) && elapsedValid(anchor.lastElapsed) && elapsedValid(anchor.elapsed) &&
  BigInt(anchor.lastWall) >= BigInt(row.minimum) && (row.replay === "0" || BigInt(Math.floor(anchor.lastElapsed)) - BigInt(anchor.elapsed) >= BigInt(row.replay));
const dominates = (actual: CooldownRow | undefined, wanted: CooldownRow) => !!actual && BigInt(actual.revision) >= BigInt(wanted.revision) && actual.phaseRevision !== undefined && wanted.phaseRevision !== undefined && BigInt(actual.phaseRevision) >= BigInt(wanted.phaseRevision) && (BigInt(actual.phaseRevision) > BigInt(wanted.phaseRevision) || (actual.sample === wanted.sample && actual.position === wanted.position)) && larger(actual.minimum, wanted.minimum) === actual.minimum && BigInt(actual.replay) >= BigInt(wanted.replay) && (!wanted.hold || actual.hold === wanted.hold || (actual.hold !== null && actual.hold !== "clock"));

export class ProviderCooldown {
  private ledger: CooldownLedger = decodeCooldown(null);
  private readonly anchors = new Map<string, Anchor>();
  private readonly reservations = new Set<Reservation>();
  private readonly pending = new Map<string, CooldownRow>();
  private readonly maintenance = new Set<string>();
  private overflowRequested = false;
  private readonly drainers = new Map<number, { promise: Promise<"drained" | "pending-terminal">; finish(result: "drained" | "pending-terminal"): void }>();
  private readonly dependencies = new Map<symbol, { owner: string; id: number | null; createdAt: number | null }>();
  private physical: Promise<void> | null = null;
  private storageFault = false;
  private unread = false;
  private recoveryTimer: Timer | null = null;
  private recoveries = 0;
  private binds: Promise<unknown> = Promise.resolve();
  private closing = false;
  private wakeQueued = false;
  private repairing = false;
  private readonly timer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  private constructor(private readonly persistence: CooldownPersistence, private readonly clock: CooldownClock, private readonly hooks: CooldownHooks) {
    this.timer = hooks.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = hooks.clearTimeout ?? ((timer) => clearTimeout(timer));
  }
  /**
   * `live` (plan 264): the accounts that exist (id, createdAt); given, the start compacts the ledger first, in one store
   * transaction (bindings of removed accounts, retired rows, unbound rows whose pause is over; overflow when all fits).
   */
  static async open(persistence: CooldownPersistence, clock: CooldownClock, hooks: CooldownHooks = {}, live?: (id: number, createdAt: number) => boolean): Promise<ProviderCooldown> {
    const gate = new ProviderCooldown(persistence, clock, hooks);
    const notice = gate.timer(() => { gate.storageFault = true; gate.changed(); }, 5000);
    try {
      let encoded = await persistence.read();
      if (encoded !== null && live) {
        const wall = clock.wallNow();
        encoded = await persistence.update((current) => { const next = compactCooldown(current, live, wall); return { encoded: next, result: next }; });
      }
      gate.ledger = decodeCooldown(encoded);
      gate.storageFault = false;
      for (const row of gate.ledger.rows) {
        gate.anchor(row);
        if (row.wall !== null && (!epoch(clock.wallNow()) || BigInt(clock.wallNow()) < BigInt(row.wall)) && !row.hold) {
          const held = { ...row, hold: "clock" as const, revision: gate.revision(), repair: null };
          gate.put(held);
          gate.enqueue(held, false, true);
        }
      }
      gate.flush();
    } catch { gate.unread = true; gate.fault(); }
    finally { gate.clearTimer(notice); }
    return gate;
  }
  private changed(): void {
    if (this.wakeQueued) return;
    this.wakeQueued = true;
    queueMicrotask(() => { this.wakeQueued = false; this.hooks.changed?.(); });
  }
  private row(owner: string, service: CooldownService): CooldownRow | undefined {
    return this.ledger.rows.find((r) => r.owner === owner && r.service === service);
  }
  private anchor(row: CooldownRow, wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow()): void {
    this.anchors.set(keyOf(row.owner, row.service), { wall, elapsed: Math.ceil(elapsed), lastWall: wall, lastElapsed: elapsed });
  }
  private put(row: CooldownRow): void {
    this.ledger.rows = this.ledger.rows.filter((r) => keyOf(r.owner, r.service) !== keyOf(row.owner, row.service));
    this.ledger.rows.push(row);
    if (BigInt(row.revision) > BigInt(this.ledger.revision)) this.ledger.revision = row.revision;
  }
  private reconcile(row: CooldownRow): CooldownRow {
    const local = this.row(row.owner, row.service);
    const checkpoint = this.anchors.get(keyOf(row.owner, row.service));
    const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
    let merged = mergeCooldownRows(local, row);
    this.put(merged);
    if (!merged.hold && (!epoch(wall) || !elapsedValid(elapsed) || (checkpoint ? !epoch(checkpoint.wall) || !elapsedValid(checkpoint.elapsed) || wall < checkpoint.lastWall || elapsed < checkpoint.lastElapsed : merged.wall !== null && BigInt(wall) < BigInt(merged.wall)))) {
      if (this.hooks.repairClock === false) {
        merged = { ...merged, hold: "clock", revision: this.revision(), repair: null };
        this.put(merged);
        this.enqueue(merged, false);
        return merged;
      }
      const same = !!local && local.minimum === merged.minimum && local.replay === merged.replay;
      return this.clockStepped(merged, same ? checkpoint : undefined, wall, elapsed, false);
    }
    if (!local || local.minimum !== merged.minimum || local.wall !== merged.wall || local.replay !== merged.replay || local.hold !== merged.hold || local.repair !== merged.repair) this.anchor(merged, wall, elapsed);
    else if (!merged.hold && checkpoint) {
      checkpoint.lastWall = wall;
      checkpoint.lastElapsed = elapsed;
    }
    return merged;
  }
  /**
   * Plan 264: a clock read earlier than before (or invalid). A pause already met at the last reading stays met: it is
   * written met at the new reading (nothing waits). One still waiting re-waits its full pause from now, at once
   * (Check clock's revision-fenced repair, which keeps every known minimum): never released early, never left held
   * while both clocks read valid. Only an invalid reading keeps the hold (Retry Now and a start lift it).
   */
  private clockStepped(row: CooldownRow, anchor: Anchor | undefined, wall: number, elapsed: number, flush: boolean): CooldownRow {
    const valid = epoch(wall) && elapsedValid(elapsed);
    // a 429 still waiting for this exact row to commit keeps it (its confirmation compares it): held, as before
    if (valid && anchor && met(row, anchor) && !this.awaited(keyOf(row.owner, row.service))) {
      const revision = this.revision();
      const moved = { ...row, revision, minimum: String(wall), wall: String(wall), replay: "0", repair: row.revision };
      this.put(moved);
      this.anchor(moved, wall, elapsed);
      this.enqueue(moved, flush);
      return moved;
    }
    const held = { ...row, hold: "clock" as const, revision: this.revision(), repair: null };
    this.put(held);
    this.enqueue(held, flush);
    if (valid && !this.awaited(keyOf(row.owner, row.service))) this.checkClock(row.owner, row.service, held.revision);
    return this.row(row.owner, row.service)!;
  }
  /** a 429's reservation still waits for this scope's row to commit (its confirmation compares that exact row) */
  private awaited(key: string): boolean {
    return [...this.reservations].some((r) => r.key === key && r.row && r.notify);
  }
  private revision(): string {
    try { this.ledger.revision = nextCooldownRevision(this.ledger.revision); }
    catch {
      this.ledger.overflow = true;
      this.overflowRequested = true;
    }
    return this.ledger.revision;
  }
  state(owner: string, service: CooldownService): CooldownState {
    if (this.closing) return Object.freeze({ kind: "hold", reason: "closed" });
    if (this.storageFault) return Object.freeze({ kind: "hold", reason: "storage" });
    if (this.ledger.overflow) return Object.freeze({ kind: "hold", reason: "overflow" });
    const row = this.row(owner, service);
    if (!row) return Object.freeze({ kind: "ready" });
    // plan 264: a clock hold is repaired as soon as both clocks read valid (and no 429 waits on that exact row)
    if (row.hold === "clock" && this.hooks.repairClock !== false && epoch(this.clock.wallNow()) && elapsedValid(this.clock.elapsedNow()) && !this.awaited(keyOf(owner, service)) && !this.repairing) {
      this.repairing = true;
      try { this.checkClock(owner, service, row.revision); } finally { this.repairing = false; }
      const repaired = this.row(owner, service)!;
      if (repaired.hold) return Object.freeze({ kind: "hold", reason: repaired.hold });
      return this.state(owner, service);
    }
    if (row.hold) return Object.freeze({ kind: "hold", reason: row.hold });
    const anchor = this.anchors.get(keyOf(owner, service))!;
    const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
    if (!epoch(wall) || !epoch(anchor.wall) || !elapsedValid(elapsed) || !elapsedValid(anchor.elapsed) || wall < anchor.lastWall || elapsed < anchor.lastElapsed) {
      // a clock stepping again while this repair reads it just holds (finite; the next read repairs it)
      if (this.repairing || this.hooks.repairClock === false) {
        const held = { ...row, hold: "clock" as const, revision: this.revision(), repair: null };
        this.put(held);
        this.enqueue(held);
        return Object.freeze({ kind: "hold", reason: "clock" });
      }
      this.repairing = true;
      try {
        const next = this.clockStepped(row, epoch(anchor.wall) && elapsedValid(anchor.elapsed) ? anchor : undefined, wall, elapsed, true);
        return next.hold ? Object.freeze({ kind: "hold", reason: next.hold }) : this.state(owner, service);
      } finally { this.repairing = false; }
    }
    anchor.lastWall = wall;
    anchor.lastElapsed = elapsed;
    // plan 264: nothing to re-wait (a retired pause) needs no elapsed reading past its anchor (rounded up)
    if (row.minimum !== null && BigInt(wall) >= BigInt(row.minimum) && (row.replay === "0" || BigInt(Math.floor(elapsed)) - BigInt(anchor.elapsed) >= BigInt(row.replay))) return Object.freeze({ kind: "ready" });
    return row.minimum === null ? Object.freeze({ kind: "hold", reason: "clock-evidence" }) : Object.freeze({ kind: "at", atMs: Number(row.minimum) });
  }
  /** Private host scope; request arguments cannot change mailbox/service ownership. */
  /** Status observes durable admission, independent of a retired request handle's liveness. */
  mailConstrained(owner: string, stamp: CooldownStamp, services: OAuthServices): boolean {
    const scopes = new Set([owner, "installation"]);
    if ([...scopes].some((scope) => this.state(scope, services.mail).kind !== "ready")) return true;
    const dependent = [...this.dependencies.values()].some((dependency) => dependency.owner === owner &&
      (owner === "installation" ? dependency.id === null : dependency.id === stamp.id && dependency.createdAt === stamp.createdAt));
    return dependent && [...scopes].some((scope) => this.state(scope, services.token).kind !== "ready");
  }

  requestsFor(owner: string, live: () => boolean = () => true): ProviderRequests {
    return this.policy(owner, live, null);
  }
  async requestsForAccount(input: CooldownStamp, live: () => boolean): Promise<ProviderRequests> {
    const stamp = { ...input };
    const owner = await this.bindingFor(stamp);
    if (!owner || !live()) throw new ProviderCooldownError("unknown", this.ledger.revision, "closed");
    return this.policy(owner, live, { id: stamp.id, createdAt: stamp.createdAt });
  }
  private policy(owner: string, live: () => boolean, stamp: { id: number; createdAt: number } | null): ProviderRequests {
    if (owner !== "installation" && !mailboxKeyValid(owner)) throw new Error("Invalid private provider scope");
    const dependency = Symbol();
    let closed = false;
    const alive = () => !closed && live();
    const close = () => { closed = true; if (this.dependencies.delete(dependency)) this.changed(); };
    const check = (d: RequestDescriptor) => {
      const service = d.request.endpoint;
      if (!alive() || !COOLDOWN_SERVICES.includes(service as CooldownService)) { close(); throw new ProviderCooldownError("unknown", this.ledger.revision, "closed"); }
      for (const scope of [owner]) {
        const state = this.state(scope, service as CooldownService);
        if (state.kind !== "ready") throw new ProviderCooldownError(service, this.row(scope, service as CooldownService)?.revision ?? this.ledger.revision, state.kind === "at" ? "timed" : state.reason);
      }
    };
    return {
      check: (d) => {
        check(d);
        if (this.reservations.size + this.maintenance.size >= COOLDOWN_TICKETS) throw new ProviderCooldownError(d.request.endpoint, this.ledger.revision, "capacity");
      },
      close,
      accessAvailable: () => { if (alive() && this.dependencies.delete(dependency)) this.changed(); },
      tokenUnavailable: () => {
        if (!alive() || this.dependencies.has(dependency)) return;
        if (this.dependencies.size >= COOLDOWN_TICKETS) { this.fault(); return; }
        this.dependencies.set(dependency, { owner, id: stamp?.id ?? null, createdAt: stamp?.createdAt ?? null });
        this.changed();
      },
      reserve: (input) => {
        const d: RequestDescriptor = { request: Object.freeze({ ...input.request }), run: input.run };
        check(d);
        if (this.reservations.size + this.maintenance.size >= COOLDOWN_TICKETS) throw new ProviderCooldownError(d.request.endpoint, this.ledger.revision, "capacity");
        const service = d.request.endpoint as CooldownService;
        const r: Reservation = { key: keyOf(owner, service), started: false, issued: false, observed: false, released: false, revision: this.row(owner, service)?.revision ?? "0" };
        this.reservations.add(r);
        if (this.reservations.size + this.maintenance.size === COOLDOWN_TICKETS) this.changed();
        const ticket: RequestTicket = {
          request: d.request,
          dispatch: (transport) => {
            if (r.started) throw new Error("Request ticket dispatch already started");
            if (r.released) throw new ProviderCooldownError(service, r.revision, "closed");
            r.started = true;
            check(d);
            r.revision = this.row(owner, service)?.revision ?? "0";
            let response: Promise<Response>;
            try { response = transport(); }
            catch (error) {
              if (!(error instanceof RequestNotDispatchedError)) { r.issued = true; d.run?.markDispatched(); }
              throw error;
            }
            r.issued = true;
            d.run?.markDispatched();
            return response.then((value) => {
              if (this.closing || !alive()) {
                void value.body?.cancel().catch(() => {});
                throw new DOMException("Provider request lifetime ended", "AbortError");
              }
              return value;
            });
          },
          headers429: (e) => {
            if (!r.issued || r.observed || r.released || this.closing || !alive()) return Promise.resolve("unconfirmed");
            r.observed = true;
            return this.observe(owner, service, e, r);
          },
          headers: (status) => {
            if (r.observed || !r.issued || r.released) return;
            r.observed = true;
            const row = this.row(owner, service);
            if (status >= 200 && status < 300 && row && row.revision === r.revision && this.state(owner, service).kind === "ready" && (row.position !== 0 || row.replay !== "0")) {
              // plan 264: Google took a request at the revision it was sent under, after the pause: that pause is over.
              // It is retired (met now, nothing to re-wait), fenced on its revision so the store's larger replay can't
              // bring it back; a 429 newer than this request has a newer revision and is untouched. While a 429's
              // commit still waits on this row (its confirmation compares it), only the backoff resets, as before.
              const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
              const revision = this.revision();
              const awaited = this.awaited(r.key);
              const reset = awaited ? { ...row, position: 0, revision, phaseRevision: revision } : { ...row, position: 0, revision, phaseRevision: revision, minimum: String(wall), wall: String(wall), replay: "0", repair: row.revision };
              this.put(reset);
              if (!awaited) this.anchor(reset, wall, elapsed);
              this.finish(r);
              this.enqueue(reset);
            }
            this.finish(r);
          },
          release: () => {
            if (r.released) return;
            r.released = true;
            if (!r.row) this.finish(r);
          },
        };
        return ticket;
      },
    };
  }
  private observe(owner: string, service: CooldownService, e: Observation429, reservation: Reservation): Promise<"committed" | "unconfirmed"> {
    const previous = this.row(owner, service);
    const checkpoint = this.anchors.get(keyOf(owner, service));
    const position = Math.min(previous?.position ?? 0, RETRY_DELAYS_MS.length - 1);
    const sample = retryJitter(RETRY_DELAYS_MS[position]!, this.clock.random());
    const elapsed = this.clock.elapsedNow();
    const wall = e.received.kind === "wall" ? e.received.wallMs : NaN;
    const now = this.clock.wallNow();
    let known = previous?.minimum ?? null;
    let hold = previous?.hold ?? null;
    let replay = BigInt(previous?.replay ?? "0");
    if (e.minimum.kind === "at") known = larger(known, String(e.minimum.atMs));
    // A Retry-After date the server got wrong (calendar, leap second, range) is a bad header like any
    // other: the timed fallback below applies. Holding on it would pause the account for good.
    if (e.minimum.kind === "hold" && e.minimum.reason === "clock") hold = "clock-evidence";
    if (!epoch(wall)) hold = "clock-evidence";
    else {
      const floor = BigInt(wall) + BigInt(sample);
      if (floor > 8_640_000_000_000_000n) hold = "range";
      else known = larger(known, floor.toString());
      if (known !== null) replay = replay > BigInt(known) - BigInt(wall) ? replay : BigInt(known) - BigInt(wall);
      if (!elapsedValid(elapsed) && (hold === null || hold === "clock")) hold = "clock";
      // a rollback is the clock *now* behind what it said before; a receipt from earlier isn't (concurrent
      // quota 403s are observed after their bodies are read, so one stamped before the last observed is normal)
      if ((hold === null || hold === "clock") && checkpoint && (!epoch(now) || now < checkpoint.lastWall || elapsed < checkpoint.lastElapsed)) hold = "clock";
    }
    const revision = this.revision();
    const row: CooldownRow = { owner, service, revision, phaseRevision: revision, minimum: known, wall: epoch(wall) ? String(wall) : null, replay: (replay < 0n ? 0n : replay).toString(), sample, position: Math.min(position + 1, 6), hold, repair: hold ? null : previous?.repair ?? null };
    reservation.row = row;
    this.put(row);
    this.anchor(row, wall, elapsed);
    // the rollback check's high-water mark is the clock as last read, never an earlier receipt
    const anchored = this.anchors.get(keyOf(owner, service))!;
    anchored.lastWall = Math.max(anchored.lastWall, checkpoint?.lastWall ?? -Infinity, epoch(now) ? now : -Infinity);
    this.enqueue(row, false, false);
    const result = new Promise<"committed" | "unconfirmed">((resolve) => {
      reservation.notify = resolve;
      reservation.timer = this.timer(() => {
        this.notify(reservation, "unconfirmed");
        this.fault();
      }, 5000);
    });
    this.flush();
    return result;
  }
  private enqueue(row: CooldownRow, flush = true, maintenance = true): void {
    const key = keyOf(row.owner, row.service);
    const observedSlot = [...this.reservations].some((r) => r.key === key && r.row);
    if (maintenance && !observedSlot && !this.maintenance.has(key)) {
      if (this.reservations.size + this.maintenance.size >= COOLDOWN_TICKETS) {
        this.ledger.overflow = true;
        this.overflowRequested = true;
        this.changed();
        if (flush) this.flush();
        return;
      }
      this.maintenance.add(key);
    }
    if ((this.pending.size >= COOLDOWN_TICKETS && !this.pending.has(key)) || byteLength(JSON.stringify(row)) > COOLDOWN_CANDIDATE_BYTES / COOLDOWN_TICKETS) {
      this.fault();
      return;
    }
    this.pending.set(key, row);
    this.changed();
    if (flush) this.flush();
  }
  private notify(r: Reservation, result: "committed" | "unconfirmed"): void {
    if (r.timer) this.clearTimer(r.timer);
    r.timer = undefined;
    r.notify?.(result);
    r.notify = undefined;
  }
  private finish(r: Reservation): void {
    const wasFull = this.reservations.size + this.maintenance.size >= COOLDOWN_TICKETS;
    if (!this.reservations.delete(r)) return;
    if (r.timer) this.clearTimer(r.timer);
    if (this.pending.has(r.key) && ![...this.reservations].some((other) => other.key === r.key && other.row)) this.maintenance.add(r.key);
    if (wasFull && this.reservations.size + this.maintenance.size < COOLDOWN_TICKETS && !this.closing && !this.storageFault && !this.ledger.overflow) this.changed();
  }
  private async commit(batch: readonly CooldownRow[], canConfirm: () => boolean): Promise<boolean> {
    let committed: CooldownLedger | undefined;
    const revision = this.ledger.revision;
    const overflow = this.ledger.overflow;
    try {
      const encoded = await this.persistence.update((current) => {
        const ledger = decodeCooldown(current);
        ledger.overflow ||= overflow;
        for (const candidate of batch) {
          const old = ledger.rows.find((r) => r.owner === candidate.owner && r.service === candidate.service);
          const merged = mergeCooldownRows(old, candidate);
          ledger.rows = ledger.rows.filter((r) => r.owner !== candidate.owner || r.service !== candidate.service);
          ledger.rows.push(merged);
        }
        ledger.revision = BigInt(ledger.revision) > BigInt(revision) ? ledger.revision : revision;
        let next: string;
        try {
          next = encodeCooldown(ledger);
          if (byteLength(next) > COOLDOWN_LEDGER_BYTES - 128) throw new Error("Private cooldown capacity");
        } catch {
          const retained = decodeCooldown(current);
          retained.overflow = true;
          retained.revision = ledger.revision;
          next = encodeCooldown(retained);
        }
        return { encoded: next, result: next };
      });
      committed = decodeCooldown(encoded);
    } catch {
      const waiting = [...this.reservations].some((r) => r.row && batch.includes(r.row) && r.notify);
      if (canConfirm() && waiting) {
        try { committed = decodeCooldown(await this.persistence.read()); } catch { /* local recovery stays explicit */ }
      }
    }
    if (!committed || (!committed.overflow && batch.some((row) => !dominates(committed!.rows.find((r) => r.owner === row.owner && r.service === row.service), row)))) {
      this.storageFault = true;
      this.overflowRequested ||= overflow;
      for (const row of batch) this.pending.set(keyOf(row.owner, row.service), this.row(row.owner, row.service) ?? row);
      for (const r of this.reservations) if (r.row) this.notify(r, "unconfirmed");
      this.changed();
      return false;
    }
    this.ledger.overflow ||= committed.overflow;
    for (const row of committed.rows) this.reconcile(row);
    for (const row of batch) {
      const key = keyOf(row.owner, row.service);
      if (!this.pending.has(key)) this.maintenance.delete(key);
    }
    this.ledger.bindings = committed.bindings;
    if (BigInt(committed.revision) > BigInt(this.ledger.revision)) this.ledger.revision = committed.revision;
    const confirmedCandidates = [...this.reservations];
    for (const r of confirmedCandidates) if (r.row && (committed.overflow || dominates(committed.rows.find((row) => row.owner === r.row!.owner && row.service === r.row!.service), r.row))) {
      this.notify(r, "committed");
      this.finish(r);
    }
    this.storageFault = false;
    this.healthy();
    this.changed();
    return true;
  }
  /** plan 264: storage stopped confirming: admission closes everywhere, and a recovery is scheduled */
  private fault(): void {
    this.storageFault = true;
    this.changed();
    this.scheduleRecovery();
  }
  /** One one-shot timer while faulted, after the physical writer ended (its end schedules it otherwise). */
  private scheduleRecovery(): void {
    if (!this.storageFault || this.closing || this.physical || this.recoveryTimer) return;
    const delay = COOLDOWN_RECOVERY_MS[Math.min(this.recoveries, COOLDOWN_RECOVERY_MS.length - 1)]!;
    this.recoveries++;
    this.recoveryTimer = this.timer(() => {
      this.recoveryTimer = null;
      if (!this.closing && this.storageFault) void this.recoverStorage().catch(() => this.scheduleRecovery());
    }, delay);
  }
  private healthy(): void {
    if (this.unread && !this.closing) {
      this.unread = false;
      queueMicrotask(() => { if (!this.closing) this.hooks.loaded?.(); });
    }
    this.recoveries = 0;
    if (this.recoveryTimer) this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
  }
  /** `ledger` false (plan 264: a bind): the store's own transaction, not a cooldown write; its failure is the caller's */
  private own(work: (withinBudget: () => boolean) => Promise<void>, ledger = true): Promise<void> {
    let withinBudget = true;
    const notice = ledger ? this.timer(() => { withinBudget = false; this.storageFault = true; this.changed(); }, 5000) : null;
    // The logical deadline never drops the physical promise or starts a competing action.
    const run = Promise.resolve().then(() => work(() => withinBudget));
    const terminal = run.catch(() => { if (ledger) { this.storageFault = true; this.changed(); } }).finally(() => { if (notice) this.clearTimer(notice); });
    this.physical = terminal;
    void terminal.then(() => {
      if (this.physical === terminal) this.physical = null;
      if (!this.storageFault) this.flush();
      else this.scheduleRecovery();
      if (!this.physical) {
        const result = this.pending.size || this.overflowRequested ? "pending-terminal" : "drained";
        const observers = [...this.drainers.values()];
        for (const observer of observers) observer.finish(result);
      }
    });
    return run;
  }
  private flush(): void {
    if (this.physical || (this.pending.size === 0 && !this.overflowRequested) || this.storageFault) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.overflowRequested = false;
    this.own(async (withinBudget) => { await this.commit(batch, withinBudget); });
  }
  checkClock(owner: string, service: CooldownService, revision: string): CooldownState {
    const row = this.row(owner, service);
    // plan 264: never while a 429 waits for this exact row to commit (it would never confirm, and keep its ticket)
    if (!row || row.revision !== revision || row.hold !== "clock" || this.closing || this.storageFault || this.ledger.overflow || this.awaited(keyOf(owner, service))) return this.state(owner, service);
    const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
    if (!epoch(wall) || !elapsedValid(elapsed)) return this.state(owner, service);
    const repaired = { ...row, revision: this.revision(), wall: String(wall), hold: null, repair: row.revision };
    this.put(repaired);
    this.anchor(repaired, wall, elapsed);
    this.enqueue(repaired);
    return this.state(owner, service);
  }
  revisionFor(owner: string, service: CooldownService): string | null { return this.row(owner, service)?.revision ?? null; }
  /** Every held row, for the host to lift on start (no control ships, so a hold would otherwise never end). */
  holds(): { owner: string; service: CooldownService; revision: string }[] {
    return this.ledger.rows.filter((row) => row.hold !== null).map((row) => ({ owner: row.owner, service: row.service, revision: row.revision }));
  }
  /**
   * A start's repair of any hold (Check clock's, for every reason): it re-waits the row's full retained
   * pause from now and keeps every known minimum, revision-fenced like Check clock.
   */
  liftHold(owner: string, service: CooldownService, revision: string): CooldownState {
    const row = this.row(owner, service);
    if (!row || row.revision !== revision || !row.hold || this.closing || this.storageFault || this.ledger.overflow || this.awaited(keyOf(owner, service))) return this.state(owner, service);
    if (row.hold === "clock") return this.checkClock(owner, service, revision);
    const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
    if (!epoch(wall) || !elapsedValid(elapsed)) return this.state(owner, service);
    // a hold from bad evidence may have no deadline: the row's own pause from now stands in for it
    const minimum = larger(row.minimum, String(wall + row.sample));
    const replay = BigInt(row.replay) > BigInt(row.sample) ? row.replay : String(row.sample);
    const repaired = { ...row, revision: this.revision(), wall: String(wall), minimum, replay, hold: null, repair: row.revision };
    this.put(repaired);
    this.anchor(repaired, wall, elapsed);
    this.enqueue(repaired);
    return this.state(owner, service);
  }
  async recoverStorage(): Promise<"confirmed" | "pending-terminal" | "unconfirmed"> {
    if (this.physical) return "pending-terminal";
    if (this.closing && this.pending.size === 0 && !this.overflowRequested) return "unconfirmed";
    this.own(async (withinBudget) => {
      const persisted = decodeCooldown(await this.persistence.read());
      let reconciled = false;
      for (const row of persisted.rows) {
        const local = this.row(row.owner, row.service);
        const merged = this.reconcile(row);
        if (!local || local.revision !== merged.revision || local.minimum !== merged.minimum || local.wall !== merged.wall || local.replay !== merged.replay || local.sample !== merged.sample || local.position !== merged.position || local.hold !== merged.hold || local.repair !== merged.repair) reconciled = true;
      }
      const bindings = new Map<number, CooldownLedger["bindings"][number]>();
      for (const binding of this.ledger.bindings) bindings.set(binding.id, binding);
      if (bindings.size !== persisted.bindings.length || persisted.bindings.some((binding) => {
        const old = bindings.get(binding.id);
        return !old || old.createdAt !== binding.createdAt || old.emailDigest !== binding.emailDigest || old.mailboxKey !== binding.mailboxKey;
      })) reconciled = true;
      const overflow = this.ledger.overflow;
      this.ledger.bindings = persisted.bindings;
      this.ledger.overflow ||= persisted.overflow;
      reconciled ||= overflow !== this.ledger.overflow;
      if (!withinBudget()) { this.storageFault = true; return; }
      if (this.ledger.overflow && !persisted.overflow) {
        if (!await this.commit([], () => false)) return;
        this.overflowRequested = false;
        persisted.overflow = true;
      }
      for (const row of this.ledger.rows) {
        if (!persisted.overflow && !dominates(persisted.rows.find((r) => r.owner === row.owner && r.service === row.service), row)) {
          const key = keyOf(row.owner, row.service);
          if (this.pending.size >= COOLDOWN_TICKETS && !this.pending.has(key)) throw new Error("Private cooldown recovery capacity");
          this.pending.set(key, row);
        }
      }
      const batch = [...this.pending.values()];
      this.pending.clear();
      if (batch.length) await this.commit(batch, () => false);
      else {
        const recovered = this.storageFault;
        this.storageFault = false;
        this.healthy();
        if (recovered || reconciled) this.changed();
      }
    });
    return await this.drain(5000) === "pending-terminal" ? "pending-terminal" : this.storageFault ? "unconfirmed" : "confirmed";
  }
  /** After a committed bind: publish the new binding only after the same serialized local read. */
  refreshAfterBind(): Promise<"confirmed" | "pending-terminal" | "unconfirmed"> { return this.recoverStorage(); }
  /**
   * Plan 264: a mailbox binding, one at a time. It waits for a writer in flight (instead of answering that someone else
   * is writing), never writes beside an unconfirmed cooldown candidate, and publishes after the same serialized local
   * read. "unconfirmed" is a local step that didn't settle: the caller tries again later, nothing latches.
   */
  bind(work: () => Promise<boolean>): Promise<"confirmed" | "refused" | "unconfirmed"> {
    const run = this.binds.then(async () => {
      if (this.closing || !await this.settled()) return "unconfirmed" as const;
      // checked in the same turn the bind takes the writer: a flush that started since settled() keeps it
      if (this.closing || this.physical || this.storageFault || this.pending.size || this.overflowRequested) return "unconfirmed" as const;
      // the bind's transaction is the physical writer while it runs: a 429 observed meanwhile flushes after it
      let bound = false;
      await this.own(async () => { bound = await work(); }, false);
      if (!bound) return "refused" as const;
      if (!await this.settled()) return "unconfirmed" as const;
      return await this.refreshAfterBind() === "confirmed" ? "confirmed" as const : "unconfirmed" as const;
    });
    this.binds = run.then(() => undefined, () => undefined);
    return run;
  }
  /** no physical writer (a flush may follow the one that ends: a few bounded waits) */
  private async settled(): Promise<boolean> {
    for (let i = 0; i < 3 && this.physical; i++) await this.drain(5000);
    return !this.physical;
  }
  /**
   * Plan 264: Retry Now. A faulted store is read again at once; otherwise every clock hold is lifted as a start lifts
   * it (re-waiting its row's full pause from now; nothing is released early).
   */
  async retry(): Promise<void> {
    if (this.closing) return;
    if (this.storageFault) {
      if (this.recoveryTimer) this.clearTimer(this.recoveryTimer);
      this.recoveryTimer = null;
      await this.recoverStorage();
      return;
    }
    await this.liftHolds(true);
  }
  /**
   * Every saved hold lifted, in batches below the write slots, drained between. The count lifted. `clockOnly`: holds
   * whose deadline is kept (a clock check); a hold on evidence that couldn't be read has none to re-wait.
   */
  async liftHolds(clockOnly = false): Promise<number> {
    const holds = this.holds().filter((hold) => !clockOnly || this.row(hold.owner, hold.service)?.hold === "clock");
    for (let i = 0; i < holds.length; i += COOLDOWN_TICKETS / 2) {
      for (const hold of holds.slice(i, i + COOLDOWN_TICKETS / 2)) this.liftHold(hold.owner, hold.service, hold.revision);
      if ((await this.drain(5000)) !== "drained") break;
    }
    return holds.length;
  }
  boundAccountIds(): readonly number[] { return this.ledger.bindings.map((binding) => binding.id); }
  /** plan 264: the mailbox key bound to this stamp now, given the stamp's address digest (synchronous, for admission) */
  boundOwner(stamp: CooldownStamp, digest: string): string | null {
    const binding = this.ledger.bindings.find((b) => b.id === stamp.id && b.createdAt === stamp.createdAt);
    return binding && !this.storageFault && !this.closing && binding.emailDigest === digest ? binding.mailboxKey : null;
  }
  async bindingFor(input: CooldownStamp): Promise<string | null> {
    const stamp = { ...input };
    const binding = this.ledger.bindings.find((b) => b.id === stamp.id && b.createdAt === stamp.createdAt);
    if (!binding || this.storageFault || this.closing) return null;
    const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
    return digest === binding.emailDigest ? binding.mailboxKey : null;
  }
  /** Transition-time only. Caller fences the account generation again before using this snapshot. */
  async admission(accountAt: (id: number) => (CooldownStamp & { kind: string }) | undefined): Promise<OpAdmission> {
    const verified: number[] = [], blocked: number[] = [];
    const dependent = new Set([...this.dependencies.values()].map((d) => `${d.owner}/${d.id}/${d.createdAt}`));
    // Bindings bound the work; do not copy/scan an unbounded imported-account list here.
    for (const b of this.ledger.bindings) {
      const found = accountAt(b.id);
      const a = found && { ...found };
      // plan 259 (Codex review #2): an account is held only by its own provider's services; a kind the ledger has none for
      // (Outlook, until its Graph provider) is neither verified nor held here
      const services = a && isOAuthKind(a.kind) ? OAUTH_SERVICES[a.kind] : undefined;
      if (!a || !services || a.createdAt !== b.createdAt || await mailboxDigest(a.email, (bytes) => crypto.subtle.digest("SHA-256", bytes)) !== b.emailDigest) continue;
      verified.push(a.id);
      const needsToken = dependent.has(`${b.mailboxKey}/${a.id}/${a.createdAt}`);
      if (this.state(b.mailboxKey, services.mail).kind !== "ready" || (needsToken && (this.state(b.mailboxKey, services.token).kind !== "ready" || this.state("installation", services.token).kind !== "ready"))) blocked.push(a.id);
    }
    try {
      const preproofDependency = [...this.dependencies.values()].some((d) => d.owner === "installation" && d.id === null);
      // plan 259: each provider's lanes from its own services; the ledger's own faults hold every OAuth provider's ops
      const all = this.storageFault || this.ledger.overflow || this.closing || this.reservations.size + this.maintenance.size >= COOLDOWN_TICKETS;
      const kinds: Partial<Record<OAuthKind, KindAdmission>> = {};
      for (const [kind, services] of Object.entries(OAUTH_SERVICES) as [OAuthKind, OAuthServices][]) {
        kinds[kind] = { unverified: this.state("installation", services.mail).kind !== "ready" || (preproofDependency && this.state("installation", services.token).kind !== "ready"), all };
      }
      return copyOpAdmission({ blockedAccountIds: blocked, verifiedAccountIds: verified, kinds });
    } catch {
      return copyOpAdmission({ blockedAccountIds: [], verifiedAccountIds: [], kinds: Object.fromEntries(Object.keys(OAUTH_SERVICES).map((kind) => [kind, { all: true, unverified: false }])) });
    }
  }
  resources(): Readonly<{ tickets: number; pendingScopes: number; reservedBytes: number; writer: boolean }> {
    return Object.freeze({ tickets: this.reservations.size, pendingScopes: this.pending.size, reservedBytes: (this.reservations.size + this.maintenance.size) * (COOLDOWN_CANDIDATE_BYTES / COOLDOWN_TICKETS), writer: this.physical !== null });
  }
  /** Feed the existing nearest-due one-shot; held-only and idle states create no timer. */
  nextWakeDelay(): number | null {
    if (this.closing || this.storageFault || this.ledger.overflow) return null;
    let next: bigint | null = null;
    for (const row of this.ledger.rows) {
      if (this.state(row.owner, row.service).kind !== "at" || row.minimum === null) continue;
      const wall = this.clock.wallNow(), elapsed = this.clock.elapsedNow();
      if (!epoch(wall) || !elapsedValid(elapsed)) return null;
      const anchor = this.anchors.get(keyOf(row.owner, row.service))!;
      const wallWait = BigInt(row.minimum) - BigInt(wall);
      const elapsedWait = BigInt(row.replay) - (BigInt(Math.floor(elapsed)) - BigInt(anchor.elapsed));
      const remaining = wallWait > elapsedWait ? wallWait : elapsedWait;
      if (remaining > 0n && (next === null || remaining < next)) next = remaining;
    }
    return next === null ? null : Number(next > 2_147_483_647n ? 2_147_483_647n : next);
  }
  drain(ms: 5000 | 30000 = 30000): Promise<"drained" | "pending-terminal"> {
    if (ms !== 5000 && ms !== 30000) return Promise.reject(new Error("Invalid cooldown observation budget"));
    if (!this.physical) return Promise.resolve(this.pending.size || this.overflowRequested ? "pending-terminal" : "drained");
    const existing = this.drainers.get(ms);
    if (existing) return existing.promise;
    let resolve!: (result: "drained" | "pending-terminal") => void;
    const promise = new Promise<"drained" | "pending-terminal">((r) => { resolve = r; });
    const finish = (result: "drained" | "pending-terminal") => {
      if (this.drainers.get(ms)?.promise !== promise) return;
      this.drainers.delete(ms);
      this.clearTimer(timer);
      resolve(result);
    };
    const timer = this.timer(() => finish("pending-terminal"), ms);
    this.drainers.set(ms, { promise, finish });
    return promise;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.healthy();
    this.dependencies.clear();
    const unobserved = [...this.reservations];
    for (const r of unobserved) if (!r.row) this.finish(r);
    while (this.physical) await this.physical;
    // Actual terminal failure is visible; the host must not publish graceful closed on rejection.
    if (this.pending.size || this.overflowRequested) throw new Error("Private cooldown persistence remains unconfirmed");
    const remaining = [...this.reservations];
    for (const r of remaining) { this.notify(r, "unconfirmed"); this.finish(r); }
  }
}
