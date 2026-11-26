import { z } from "zod";
import { fnv1a } from "./categorize/features";
import { parseReasons } from "./categorize/explain";
import type { CategoryId, Reason, ThreadId } from "./types";

/**
 * Plan 282: Put away. What took a conversation out of the Inbox without the user, recorded when it happened (one row per
 * conversation, the newest wins), with what the reader's box and the view's rows need to say who did it and why.
 */

/** How long a placement is listed in Put away (and its box shows in the reader) */
export const PUT_AWAY_DAYS = 7;
export const PUT_AWAY_MS = PUT_AWAY_DAYS * 86_400_000;

/** What a rule did that took mail out of the Inbox (spam isn't one: Spam triggers nothing) */
export const PLACEMENT_ACTIONS = ["archive", "trash", "moveToFolder", "addCategory"] as const;
export type PlacementAction = (typeof PLACEMENT_ACTIONS)[number];

const ruleDetail = z.object({
  by: z.literal("rule"),
  filterId: z.number().int().positive(),
  name: z.string().max(500),
  /** Terno made it (plan 90, plan 217's "similar" rules) */
  auto: z.boolean(),
  source: z.string().max(40),
  createdAt: z.number(),
  action: z.enum(PLACEMENT_ACTIONS),
  categoryId: z.number().int().positive().optional(),
  folder: z.string().max(1000).optional(),
  /** the rule as it was (ruleHash of its rule): an edited rule no longer offers Edit or Stop for what it did */
  ruleHash: z.string().max(20),
  /** who the mail is from, as it came (the newest message someone else sent) */
  fromName: z.string().max(400),
});

const ternoDetail = z.object({
  by: z.literal("terno"),
  categoryId: z.number().int().positive(),
  /** the decision's reasons, as stored (explain_json) */
  reasons: z.unknown(),
  /** the classifier's normalized sender ("Don't file … automatically" keys by it) */
  sender: z.string().max(400),
  /** who the mail is from, as the decision saw them */
  fromName: z.string().max(400),
});

export type RulePlacement = z.infer<typeof ruleDetail>;
export type TernoPlacement = Omit<z.infer<typeof ternoDetail>, "reasons"> & { reasons: Reason[] };
export type PlacementDetail = RulePlacement | TernoPlacement;

/** A conversation put away: when, whether it needs a look (from someone you've written to), and what did it. */
export interface Placement {
  threadId: ThreadId;
  at: number;
  needsLook: boolean;
  detail: PlacementDetail;
}

/** The reader's: the placement, and whether the rule that did it is still as it was (absent for Terno's own filings). */
export interface PutAwayDetail extends Placement {
  /** the rule still exists and is unchanged: Edit and Stop act on what did this */
  ruleLive?: boolean;
}

/** A rule's identity for Put away: the rule as JSON, hashed (an edit changes it; renaming or pausing it doesn't). */
export function ruleHash(rule: unknown): string {
  return fnv1a(JSON.stringify(rule)).toString(36);
}

/** What a placement did, as stored (`placements.effect`): what a read checks still holds. */
export type PlacementEffect = "archive" | "trash" | "folder" | "category";

/** A stored detail (detail_json), validated: anything this version doesn't know reads as nothing (plan 267). */
export function parsePlacementDetail(json: string): PlacementDetail | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const rule = ruleDetail.safeParse(value);
  if (rule.success) return rule.data;
  const terno = ternoDetail.safeParse(value);
  if (terno.success) return { ...terno.data, reasons: parseReasons(JSON.stringify(terno.data.reasons ?? [])) };
  return null;
}

/** The detail as stored */
export function placementJson(detail: PlacementDetail): string {
  return JSON.stringify(detail);
}

/** Inside the window at `now` */
export function placementLive(at: number, now: number): boolean {
  return at > now - PUT_AWAY_MS;
}

/** The reasons worth saying first: who the user keeps there, else what the mail is; never counter-evidence or "new sender". */
const IDENTITY = new Set(["reason.sameSender", "reason.sameList", "reason.sameDomain"]);
const SKIPPED = new Set(["reason.alsoElsewhere", "reason.newSender"]);

/**
 * Terno's filing, said strongest first: the identity reason (you keep N from this sender, list or domain there), else the
 * first other reason; the rest after it. Plain strings (reasons stored before they were localized) are kept as they are.
 */
export function orderReasons(reasons: readonly Reason[]): { lead: Reason | null; rest: Reason[] } {
  const usable = reasons.filter((r) => typeof r === "string" || !SKIPPED.has(r.k));
  const lead = usable.find((r) => typeof r !== "string" && IDENTITY.has(r.k)) ?? usable[0] ?? null;
  return { lead, rest: usable.filter((r) => r !== lead) };
}

/** The category a placement names, if any */
export function placementCategory(d: PlacementDetail): CategoryId | null {
  return d.by === "terno" ? d.categoryId : d.action === "addCategory" ? (d.categoryId ?? null) : null;
}
