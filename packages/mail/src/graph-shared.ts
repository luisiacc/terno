// Plan 259: what the Graph provider's read side (graph-api.ts) and its writes (graph-writes.ts) share: the role
// folders, the folder catalog and a request's shape. No Node APIs.
import type { ProviderFolder } from "@terno/store";
import type { HttpRequestContext, MailAdmission, RequestRun } from "./types";

/** on every Graph call, a batch's requests too: it "only applies to the request it is included with" (outlook-immutable-id) */
export const IMMUTABLE = 'IdType="ImmutableId"';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Graph's error codes in an answer's body, top-level and nested (only tokens; never message text). */
export function codesOf(body: unknown): string[] {
  const codes: string[] = [];
  let error: unknown = isRecord(body) ? body.error : undefined;
  for (let depth = 0; isRecord(error) && depth < 5; depth++) {
    if (typeof error.code === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(error.code)) codes.push(error.code);
    error = error.innererror ?? error.innerError;
  }
  return codes;
}

/**
 * The mailbox itself refused ("REST API is not yet supported for this mailbox": learn.microsoft.com/troubleshoot/exchange/
 * user-and-shared-mailboxes/rest-api-is-not-yet-supported-for-this-mailbox-error): a 404 that says nothing of a message.
 */
const MAILBOX_REFUSED = new Set(["mailboxnotenabledforrestapi", "mailboxnotsupportedforrestapi"]);
export const mailboxRefusedCodes = (codes: readonly string[]) => codes.some((code) => MAILBOX_REFUSED.has(code.toLowerCase()));

export type Role = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";
/** Graph's well-known folder names (learn.microsoft.com/graph/api/resources/mailfolder) for Terno's roles */
export const ROLES: Record<Role, string> = { inbox: "inbox", sent: "sentitems", drafts: "drafts", trash: "deleteditems", junk: "junkemail", archive: "archive" };

/** A folder Terno syncs: a role folder (its flags say where) or one of the person's own (its id is the folder key). */
export interface SyncedFolder { id: string; role?: Role }

export interface Catalog {
  at: number;
  byRole: Partial<Record<Role, string>>;
  synced: Map<string, SyncedFolder>;
  folders: ProviderFolder[];
  /** stage 2b: every folder listed (role folders too), by id: its name and parent (null: the top), for folder changes */
  tree: Map<string, { name: string; parent: string | null }>;
}

export interface Call {
  /** the caller's (a pass's, a reader's) */
  signal?: AbortSignal;
  readReset?: AbortSignal;
  /** a pass that gave up: its queued requests never leave */
  preparation?: AbortSignal;
  context?: HttpRequestContext;
  admission?: MailAdmission;
  proofToken?: string;
  /** the proof's read with a token already renewed once: a 401 now means signing in again */
  proofFinal?: boolean;
  generation?: number;
  limit?: number;
  /** `Prefer: odata.maxpagesize` */
  page?: boolean;
  /** a delta link: its expiry is DeltaExpired */
  delta?: boolean;
  /** stage 2b: a write, its body (JSON unless `contentType` says otherwise) */
  method?: "POST" | "PATCH" | "DELETE";
  body?: RequestInit["body"];
  contentType?: string;
  /** the op's run: its requests mark themselves dispatched (a pause met before that gives the attempt back) */
  run?: RequestRun;
  /**
   * The submission (sendMail, a draft's send): never cut by reset(), a send's long deadline, and once it may have left,
   * a failure is an unknown outcome (plan 65: never sent again)
   */
  submission?: true;
  /** 202 or 204: the answer has no body */
  empty?: true;
  /**
   * Plan 272: the answer is a message's source (`$value`), kept as its bytes: read bounded as incoming mail is, with the
   * large-read permit past the first 256 KB, never parsed
   */
  original?: true;
  /**
   * A JSON batch of this many requests: its throttled ones reach the ledger as a top-level 429 does (onBatch); each counts
   * against Outlook's pace, and it holds as many of the four slots as Graph runs of it at once ("up to four individual
   * requests from the batch at a time": learn.microsoft.com/graph/throttling-limits)
   */
  batch?: number;
}
