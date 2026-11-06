import type { LanguageReason } from "./language";
import type { AiProviderId } from "../ai";
import type { IntentDecision } from "./intent";
import type { SpecificFinding } from "./checks";
import type { Habits, VoiceJudgment, VoiceScope } from "./types";

/**
 * Plan 133: what crosses the RPC boundary. Renderer-only, through `ai.compose`, `ai.resolveIntent` and `writing.*`:
 * none of this is in `AppSettings`, an account's DTO or `app.bootstrap`, and none of those methods is in `MCP_ALLOWED`.
 */

export const WRITING_INSTRUCTIONS_MAX = 2000;
export const WRITING_ONE_OFF_MAX = 1000;
/** The largest text a generation can be, far past what the model may write. */
export const GENERATION_TEXT_MAX = 64 * 1024;

export interface WritingGlobalPrefs {
  enabled: boolean;
  instructions: string;
  useSentMail: boolean;
}

export interface WritingAccountPrefs {
  instructions?: string;
  /** false: this account's drafts leave out the general instructions */
  useGeneral?: boolean;
  /** overrides the general setting, for this account */
  useSentMail?: boolean;
  /** plan 144: false: this account's mail is never prepared */
  prepareReplies?: boolean;
}

export interface WritingPrefs {
  global: WritingGlobalPrefs;
  /** by account id */
  accounts: Record<string, WritingAccountPrefs>;
}

export const DEFAULT_WRITING_PREFS: WritingPrefs = { global: { enabled: true, instructions: "", useSentMail: true }, accounts: {} };

/** What a draft was made from, so the strip can say so truthfully (§10.1). */
export interface WritingUsed {
  /** the voice levels that went into the draft, general to specific */
  levels: VoiceScope[];
  /** the person's profile came from another of the user's accounts */
  personFromOtherAccount: boolean;
  /** whole messages to this person */
  examples: number;
  pastConversations: number;
  /** other mail naming someone they've no history with: a contact form, a notification, an introduction */
  mentions: number;
  threadMessages: number;
  /** `none`: never written to; `unavailable`: written to, but with no usable text here; never call that person new */
  history: "none" | "found" | "unavailable";
  /** no profile yet because the first pass hasn't finished: "Still learning how you write" */
  learning: boolean;
  /** the message it answers was too big to keep: only its snippet was there */
  inboundSnippetOnly: boolean;
  /** a language's code, or "" when it couldn't tell */
  language: string;
  languageReason: LanguageReason;
  provider: AiProviderId;
  model: string;
  /** Regenerate and "Shorter" re-used what the first draft assembled */
  reused: boolean;
}

export interface WritingChecks {
  /** "Check: 19 March isn't in the conversation" */
  specifics: SpecificFinding[];
  /** the `[placeholders]` in the text, in order: the caret goes to the first */
  placeholders: string[];
}

export type AiComposeResult =
  | {
      status: "done";
      /** the body: no signature, no quotes */
      text: string;
      /** set when `needsSubject` asked for one and the model gave one */
      subject: string | null;
      /** `length`: keep the text, with "This was cut off" */
      stop: "end" | "length";
      used: WritingUsed;
      checks: WritingChecks;
    }
  /** the message it answers has no text here yet: the row says "Still downloading this message"; ask again when it does */
  | { status: "waitingBody"; messageId: number };

/** One slice of a stream, to the connection that asked: append `text`. Coalesced to about 30 ms. */
export interface AiComposeDelta {
  requestId: string;
  text: string;
}

export type IntentSurfaceParam = { kind: "thread"; threadId: number } | { kind: "list" } | { kind: "draft"; recipients: { name: string; email: string }[] };

export interface AiIntentResult {
  decision: IntentDecision;
  /** for a new message: the account that last wrote to them; null keeps the current one */
  fromAccountId: number | null;
  /** `parseIntent` couldn't answer, so the route stayed as it was: the row says so */
  confirmFailed: boolean;
}

export interface WritingProfileView {
  scope: VoiceScope;
  /** `you`, `account:3`, `domain:3:acme.com`, `person:3:tom@acme.com` */
  scopeKey: string;
  /** "" holds all of the scope's mail; a code, that language's */
  language: string;
  accountId: number | null;
  samples: number;
  /** sent mail since the profile's judgment, or since it was edited: "Update" on a pinned one */
  newSince: number;
  /** pinned: a refresh offers "Update" rather than overwriting */
  edited: boolean;
  updatedAt: number;
  habits: Habits;
  phrases: string[];
  /** null until "Let AI study my style" */
  judgment: VoiceJudgment | null;
  model: string | null;
  provider: string | null;
}

export interface WritingStatus {
  /** `off`: "Learn from my sent mail" is off; `idle`: nothing asked for it yet; `learning`: a pass is running or due */
  state: "off" | "idle" | "learning" | "ready";
  /** sent messages the profiles were built from */
  messages: number;
  updatedAt: number | null;
  /** the model step: whether the user agreed, for which provider and accounts */
  study: { provider: string; accountIds: number[]; at: number } | null;
}

export type WritingStudyResult =
  /** nothing has been sent: show the consent wording with these numbers, and call again with `confirm` */
  | { status: "consent"; provider: AiProviderId; /** where this would go: `confirm` hands it back, and anywhere else asks again */ destination: string; messages: number; tokens: number; usd: number | null; accountIds: number[] }
  /** it runs in the background, with `aiStudy` events */
  | { status: "started"; total: number }
  /** nothing to study yet: the local pass hasn't found enough mail */
  | { status: "nothing" };

export interface AiStudyProgress {
  requestId: string;
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  /** an AiErrorKind, when it failed */
  errorKind?: string;
}
