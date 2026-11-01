import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";

/** Facts whose committed change invalidates prepared body publication. */
export const BODY_FACT_TABLES = ["body_heads", "filters", "accounts", "secrets", "message_locations", "imap_identity_holds"] as const;
export class BodyEpochChanged extends Error { constructor(readonly durable = false) { super("Body transaction authority changed"); } }
export interface BodyTicket { readonly epoch: string; check(): void }

/** Stage and read pins share one lifetime; the adapter owns durable transaction admission. */
export class BodyProtocol {
  private readonly reclaiming = new Set<string>();
  private readonly pins = new Map<string, number>();
  constructor(private readonly epoch: () => string, private readonly retired: (id: string) => void) {}
  ticket(check: () => void = () => {}): BodyTicket { return { epoch: this.epoch(), check }; }
  validate(ticket: BodyTicket): void {
    ticket.check();
    if (ticket.epoch !== this.epoch()) throw new BodyEpochChanged();
  }
  retain(id: string): () => void {
    if (this.reclaiming.has(id)) throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const n = this.pins.get(id)! - 1;
      if (n) this.pins.set(id, n); else { this.pins.delete(id); this.retired(id); }
    };
  }
  claimReclaim(id: string): () => void {
    if (this.held(id) || this.reclaiming.has(id)) throw new BodyEpochChanged();
    this.reclaiming.add(id);
    return () => { this.reclaiming.delete(id); };
  }
  held(id: string): boolean { return this.pins.has(id); }
}

/** Each conflict requires an observed committed epoch change; no timer, polling or source replay. */
export async function publishBody<V>(work: () => Promise<V>, check: () => void): Promise<V> {
  for (let conflicts = 0; ; conflicts++) {
    check();
    try { return await work(); }
    catch (error) {
      if (!(error instanceof BodyEpochChanged)) throw error;
      check();
      if (conflicts === 7) throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
    }
  }
}
