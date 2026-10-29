/**
 * Plan 69: what the mailbox takes on this device, by the views the user knows,
 * and which old conversations Terno may remove from it (its copy only: the mail
 * server keeps its own).
 */

/** Where a conversation counts, first match wins: trash, spam, inbox, sent (one you wrote in), archive. */
export const STORAGE_BUCKETS = ["inbox", "archive", "sent", "spam", "trash"] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/** Sent is never removable: every Sent conversation is one you replied in, which is always kept. */
export const REMOVABLE_BUCKETS = ["inbox", "archive", "spam", "trash"] as const satisfies readonly StorageBucket[];
export type RemovableBucket = (typeof REMOVABLE_BUCKETS)[number];

/** "Older than": the ages offered, in days (the report counts what each would remove). */
export const STORAGE_AGES = [30, 90, 180, 365, 730] as const;
export type StorageAge = (typeof STORAGE_AGES)[number];

const DAY = 86_400_000;

export function storageBucket(t: { inInbox: boolean; inTrash: boolean; inSpam: boolean; hasSent: boolean }): StorageBucket {
  if (t.inTrash) return "trash";
  if (t.inSpam) return "spam";
  if (t.inInbox) return "inbox";
  return t.hasSent ? "sent" : "archive";
}

/** One conversation as the storage report and removal read it. */
export interface StorageThreadRow {
  id: number;
  accountId: number;
  bucket: StorageBucket;
  /** its newest message: "older than" reads this */
  lastDate: number;
  /**
   * never removed: starred, replied in, a draft on it, local or unsent mail, or a change still on its way to the
   * server (an op not settled, a flag not yet confirmed)
   */
  kept: boolean;
  messages: number;
  /** the provider's size of its messages (an estimate of the mail, not of the disk) */
  bytes: number;
}

/** The cutoff for an age: conversations whose newest message is older than this go. */
export const storageCutoff = (now: number, days: number): number => now - days * DAY;

export function removable(row: Pick<StorageThreadRow, "bucket" | "kept" | "lastDate">, buckets: readonly StorageBucket[], cutoff: number): boolean {
  return !row.kept && row.bucket !== "sent" && buckets.includes(row.bucket) && row.lastDate < cutoff;
}

export interface StorageAmount {
  threads: number;
  messages: number;
  bytes: number;
}

export interface StorageBucketReport extends StorageAmount {
  bucket: StorageBucket;
  /** what "older than STORAGE_AGES[i]" would remove from it (cumulative: older than a month includes older than a year) */
  removable: StorageAmount[];
}

export interface StorageReport {
  /** what the mailbox takes on disk, measured; `free`: pages inside it that are reused for new mail (null: the host can't tell) */
  disk: { bytes: number; free: number } | null;
  /** SQLite on desktop: the free space is given back the next time Terno opens */
  compactPending: boolean;
  buckets: StorageBucketReport[];
  at: number;
}

const zero = (): StorageAmount => ({ threads: 0, messages: 0, bytes: 0 });
const add = (a: StorageAmount, row: StorageThreadRow) => {
  a.threads++;
  a.messages += row.messages;
  a.bytes += row.bytes;
};

/** The report's fold: rows in any order, any number of calls. */
export class StorageTally {
  private readonly buckets = new Map<StorageBucket, StorageBucketReport>(
    STORAGE_BUCKETS.map((bucket) => [bucket, { bucket, ...zero(), removable: STORAGE_AGES.map(zero) }]),
  );
  private readonly cutoffs: number[];

  constructor(now: number) {
    this.cutoffs = STORAGE_AGES.map((days) => storageCutoff(now, days));
  }

  add(rows: readonly StorageThreadRow[]): void {
    for (const row of rows) {
      const b = this.buckets.get(row.bucket)!;
      add(b, row);
      if (row.kept || row.bucket === "sent") continue;
      for (let i = 0; i < this.cutoffs.length; i++) if (row.lastDate < this.cutoffs[i]!) add(b.removable[i]!, row);
    }
  }

  result(): StorageBucketReport[] {
    return [...this.buckets.values()];
  }
}
