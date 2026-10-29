export type SentCopyState = "pending" | "rejected" | "unknown" | "saved";

/** Address-free projection; wire and server identity stay inside the backend. */
export interface SentCopyInfo {
  opId: string;
  accountId: number;
  submission: "pending" | "accepted";
  copy: SentCopyState;
  createdAt: number;
  retiring?: boolean;
}
