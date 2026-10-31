export type CaptureLocator =
  | { kind: "gmail"; providerId: string }
  | { kind: "imap"; messageId: number; mailbox: string; uidvalidity: number; uid: number };
export type CaptureReason = "mime-parts" | "mime-depth";
export interface CaptureRepair {
  key: string;
  locator: CaptureLocator;
  reason: CaptureReason;
  state: "blocked" | "pending";
  revision: number;
}
export interface CaptureRepairPage { items: CaptureRepair[]; next?: string }
export interface CaptureTicket { key: string; revision: number }
