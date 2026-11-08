import type { LearnedProposal } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { useApp, type AppState } from "~/state/app";

/**
 * Plan 159: a learned rule's offer, in words and in time. Its condition is said one way everywhere (the list's offer,
 * Rules): the rule's own field, whole. The offer shows in the Inbox once: the first time it's on screen it's seen (kept
 * on this Mac, like a tip), and it stays for that visit; once you leave the Inbox it isn't offered in a list again, and
 * no other one takes its place until the next launch. Rules keeps every offer.
 */

type Who = Pick<LearnedProposal, "scope" | "value">;
const FROM = { sender: "learned.from.sender", domain: "learned.from.domain", list: "learned.from.list" } as const;
const LINE = { archive: "list.learned.line.archive", trash: "list.learned.line.trash", spam: "list.learned.line.spam" } as const;
const SENTENCE = { archive: "list.learned.archive", trash: "list.learned.trash", spam: "list.learned.spam" } as const;
const CREATED = { archive: "list.learned.created.archive", trash: "list.learned.created.trash", spam: "list.learned.created.spam" } as const;
const PROPOSAL = { archive: "filters.proposal.archive", trash: "filters.proposal.trash", spam: "filters.proposal.spam" } as const;

/** Whose mail the rule takes, as the rule reads it: "from ana@x.com", "from anyone at x.com", "from the list x". */
export const learnedFrom = (p: Who): string => t(FROM[p.scope], { value: p.value });
/** The offer's question: "Always archive mail from anyone at x.com?" */
export const learnedLine = (p: LearnedProposal): string => t(LINE[p.action], { from: learnedFrom(p) });
/** Why it's offered: "You always archive mail from anyone at x.com (12 times)." */
export const learnedWhy = (p: LearnedProposal): string => t(SENTENCE[p.action], { from: learnedFrom(p), count: p.support });
/** What the rule does from now on, said once it's made. */
export const learnedCreated = (p: LearnedProposal): string => t(CREATED[p.action], { from: learnedFrom(p) });
/** Rules' line for an offer: "Archive mail from anyone at x.com". */
export const learnedRule = (p: LearnedProposal): string => t(PROPOSAL[p.action], { from: learnedFrom(p) });

/** The offers seen, newest last; a bounded few (keys are a scope, a value and an action: small) */
export const SEEN_KEY = "terno:learned-seen";
export const SEEN_MAX = 200;
/** Answered or shown this launch (×, a rule made, one on screen): no other offer until the next launch */
const HUSH_KEY = "terno:learned-hushed";

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string").slice(-SEEN_MAX) : [];
  } catch {
    return [];
  }
}
function readHush(): boolean {
  try {
    return sessionStorage.getItem(HUSH_KEY) === "1";
  } catch {
    return false;
  }
}

/** The place an offer was shown in: leaving it (another mailbox, an account, a search, Review) ends the visit */
type Place = Pick<AppState, "view" | "accountId" | "categoryId" | "folder" | "gmailTab" | "reviewCategoryId" | "reminders" | "followups" | "today" | "actionPreview" | "query">;
const placeOf = (s: Place): string => JSON.stringify([s.view, s.accountId, s.categoryId, s.folder, s.gmailTab, s.reviewCategoryId, s.reminders, s.followups, s.today, s.actionPreview, s.query.trim()]);

interface OfferState {
  /** the backend's offers, in its order */
  proposals: readonly LearnedProposal[];
  seen: ReadonlySet<string>;
  hushed: boolean;
  /** the offer on screen this visit, and where: it stays until you leave, though it's been seen */
  visit: { key: string; place: string } | null;
  /** the offer's height as laid out (it wraps in a narrow list): the room the rows leave above them */
  height: number;
}

/** One line's height: what the rows leave before the offer has been measured */
export const LEARNED_H = 32;

export const useOffer = create<OfferState>(() => ({ proposals: [], seen: new Set(readSeen()), hushed: readHush(), visit: null, height: LEARNED_H }));

/** The offer to show now, if any: this visit's, else the first not seen yet; none once hushed. */
export function offerOf(s: Pick<OfferState, "proposals" | "seen" | "hushed" | "visit">): LearnedProposal | null {
  if (s.hushed) return null;
  if (s.visit) return s.proposals.find((p) => p.key === s.visit!.key) ?? null;
  return s.proposals.find((p) => !s.seen.has(p.key)) ?? null;
}

/** The backend's offers, as they come (counts change often: the list renders only when the offer does). */
export function setProposals(proposals: readonly LearnedProposal[]): void {
  const was = useOffer.getState().proposals;
  const same = was.length === proposals.length && was.every((p, i) => p.key === proposals[i]!.key && p.support === proposals[i]!.support);
  if (!same) useOffer.setState({ proposals });
}

/** It's on screen in this place: seen from now on, here and in every other window, and kept for this visit. */
export function noteShown(key: string, place: Place): void {
  const s = useOffer.getState();
  if (s.visit?.key === key) return;
  const seen = [...[...s.seen].filter((k) => k !== key), key].slice(-SEEN_MAX);
  useOffer.setState({ seen: new Set(seen), visit: { key, place: placeOf(place) } });
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    // and this launch has had its offer: a reload of the window shows no other (Codex code review round 2 #2); the one
    // on screen stays for its visit
    sessionStorage.setItem(HUSH_KEY, "1");
  } catch {
    // storage refused: it may show once more next launch, which is harmless
  }
}

/** Answered (on), or not any more (Undo, within the visit that showed it): kept for the session, a reload of the window included. */
export function hush(on: boolean): void {
  useOffer.setState({ hushed: on });
  try {
    if (on) sessionStorage.setItem(HUSH_KEY, "1");
    else sessionStorage.removeItem(HUSH_KEY);
  } catch {
    // private mode: this window only
  }
}

/** A rule made and then undone: the offer comes back only while the visit that showed it lasts (the launch has had its offer all the same). */
export function unhush(key: string): void {
  if (useOffer.getState().visit?.key === key) useOffer.setState({ hushed: false });
}

/** The offer's laid-out height, as measured. */
export function setOfferHeight(height: number): void {
  if (useOffer.getState().height !== height) useOffer.setState({ height });
}

// leaving the place it was shown in ends the visit, and the launch's offer with it
useApp.subscribe((s) => {
  const visit = useOffer.getState().visit;
  if (!visit || visit.place === placeOf(s)) return;
  useOffer.setState({ visit: null });
  hush(true);
});

// another window saw one: seen here too (the visit on screen here stays)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === SEEN_KEY || e.key === null) useOffer.setState({ seen: new Set(readSeen()) });
  });
}
