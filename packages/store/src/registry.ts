import type { MailStore } from "./mail-store";
import type { Platform } from "./platform";

export interface StoreOpenOptions {
  /** the mailbox's name: one database per name ("unica" in production) */
  name: string;
  platform: Platform;
  /** answer searches from the in-memory instant index when it is current (default); false: the durable path only (FTS5, or an exact scan) */
  instantSearch?: boolean;
  log?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

/**
 * One way to keep the mailbox. Adapters are plug-and-play: anything that
 * passes `defineStoreConformance` (packages/store/src/conformance) can be
 * registered, picked by id, and the backend never knows which one it got.
 * See docs/STORAGE.md.
 */
export interface StoreAdapter {
  /** stable id, also what `?storage=` and the pinned choice name ("opfs-sqlite", "idb", …) */
  readonly id: string;
  readonly label: string;
  /**
   * May be picked automatically for a new mailbox when nothing else is
   * pinned (in registration order). An adapter becomes automatic only after
   * it passed conformance and the browser perf gate; until then it is
   * reachable by explicit choice only.
   */
  readonly automatic: boolean;
  /** the platform supports it (e.g. OPFS sync access handles in this worker) */
  available(): Promise<boolean>;
  /** a mailbox with this name already lives here */
  exists(name: string): Promise<boolean>;
  /** opens (creating and migrating) the mailbox */
  open(options: StoreOpenOptions): Promise<MailStore>;
}

export type StoreChoice =
  | { adapter: StoreAdapter; reason: "requested" | "pinned" | "existing" | "default" }
  | { adapter: null; reason: "unavailable"; message: string };

/**
 * The adapters a host offers, in preference order. `pick` never trades an
 * existing mailbox for an empty one: an explicit or pinned adapter that is
 * unavailable is an error, not a cue to fall back.
 */
export class StoreRegistry {
  private readonly adapters: StoreAdapter[] = [];

  register(adapter: StoreAdapter): this {
    if (this.adapters.some((a) => a.id === adapter.id)) throw new Error(`storage adapter ${adapter.id} is already registered`);
    this.adapters.push(adapter);
    return this;
  }

  get(id: string): StoreAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  list(): readonly StoreAdapter[] {
    return this.adapters;
  }

  /**
   * requested (`?storage=`) → pinned (the adapter this mailbox was created
   * with) → whichever adapter already holds a mailbox of this name → the
   * first available automatic adapter.
   */
  async pick(o: { name: string; requested?: string | null; pinned?: string | null }): Promise<StoreChoice> {
    for (const [id, reason] of [
      [o.requested, "requested"],
      [o.pinned, "pinned"],
    ] as const) {
      if (!id) continue;
      const adapter = this.get(id);
      if (!adapter) return { adapter: null, reason: "unavailable", message: `Unknown storage "${id}" (known: ${this.adapters.map((a) => a.id).join(", ")})` };
      if (!(await adapter.available())) return { adapter: null, reason: "unavailable", message: `${adapter.label} is not available in this browser` };
      return { adapter, reason };
    }
    for (const adapter of this.adapters) {
      if ((await adapter.available()) && (await adapter.exists(o.name))) return { adapter, reason: "existing" };
    }
    for (const adapter of this.adapters) {
      if (adapter.automatic && (await adapter.available())) return { adapter, reason: "default" };
    }
    return { adapter: null, reason: "unavailable", message: "No storage available in this browser (OPFS and IndexedDB are both missing)" };
  }
}
