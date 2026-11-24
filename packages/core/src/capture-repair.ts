export type CaptureLocator =
  | { kind: "gmail"; providerId: string }
  | { kind: "imap"; messageId: number; mailbox: string; uidvalidity: number; uid: number };
/**
 * Why a message's own content can't be read safely (plan 267). The database stores the reason as text with no list of
 * its own: a new one is a change here, never a migration.
 */
export const CAPTURE_REASONS = ["mime-parts", "mime-depth", "mime-headers", "mime-addresses"] as const;
export type CaptureReason = typeof CAPTURE_REASONS[number];
export const isCaptureReason = (value: unknown): value is CaptureReason => (CAPTURE_REASONS as readonly unknown[]).includes(value);
/** What Terno knows about a message it couldn't read, for the list (plan 267): each part optional, the whole bounded. */
export interface CaptureDetail { subject?: string; from?: string; date?: number }
export const CAPTURE_DETAIL_TEXT_MAX = 200;
export interface CaptureRepair {
  key: string;
  locator: CaptureLocator;
  /** "unknown": a reason a newer build wrote on the same schema (plan 267: read, never refused) */
  reason: CaptureReason | "unknown";
  state: "blocked" | "pending";
  revision: number;
  detail?: CaptureDetail;
}
export interface CaptureRepairPage { items: CaptureRepair[]; next?: string }
export interface CaptureTicket { key: string; revision: number }
