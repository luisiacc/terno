/**
 * Plan 178: Starred, Archive, Spam and Trash take dropped mail and do their action. Pure: the targets' refs, and what a
 * drop on each would do, decided from the dragged rows once at the drag's start (pointer moves never walk them).
 */
import type { ThreadAction, ThreadSummary, View } from "@terno/core";
import { t } from "@terno/i18n";
import type { DropState } from "~/lib/drag";
import { viewLabel } from "~/lib/format";
import { placeOf } from "~/lib/places";

/** The views that take a drop, and the action a drop there does (Starred stars, never unstars). */
export const DROP_ACTIONS = { starred: "star", archive: "archive", spam: "spam", trash: "trash" } as const satisfies Partial<Record<View, ThreadAction>>;
export type DropView = keyof typeof DROP_ACTIONS;
export const takesDrop = (view: View | null | undefined): view is DropView => !!view && Object.hasOwn(DROP_ACTIONS, view);

/** A prefix of its own: a `folderRef` is "<accountId>:<key>", and an IMAP folder may well be called "archive". */
const PREFIX = "view:";

/** The target: the view for every account, or one account's (that account's mail only). */
export const actionRef = (view: DropView, accountId: number | null = null): string => (accountId === null ? `${PREFIX}${view}` : `${PREFIX}${view}:${accountId}`);

export function parseActionRef(ref: string): { view: DropView; accountId: number | null } | null {
  if (!ref.startsWith(PREFIX)) return null;
  const [view, account, ...rest] = ref.slice(PREFIX.length).split(":");
  if (!takesDrop(view as View) || rest.length) return null;
  if (account === undefined) return { view: view as DropView, accountId: null };
  const accountId = Number(account);
  return account !== "" && Number.isInteger(accountId) ? { view: view as DropView, accountId } : null;
}

type Row = Pick<ThreadSummary, "id" | "accountId" | "starred" | "inInbox" | "inSpam" | "inTrash" | "hasSpam">;

/** What about the dragged rows decides each target. */
export interface ActionFacts {
  accounts: ReadonlySet<number>;
  /** the ids each view's action would change (a drop acts on these only) */
  fits: Readonly<Record<DropView, readonly number[]>>;
  /** every row is there already */
  already: Readonly<Record<DropView, boolean>>;
}

/** Which of these ids the action takes, as `act()` would narrow them (a search's rule, plan 64); none: all of them. */
export type Narrow = (action: ThreadAction, ids: number[]) => number[];

/**
 * What a drop on each place would do to these rows: the ones not there yet (Archive: the ones in the Inbox, all its
 * action changes), narrowed as the action's own button would. A row whose place isn't known (an older backend) is
 * never there yet: the backend decides. `onTop`: on the Inbox's top for a due reminder or follow-up (plans 87, 142),
 * which Archive ends wherever the row lives.
 */
export function actionFacts(rows: readonly Row[], narrow: Narrow = (_, ids) => ids, onTop: (id: number) => boolean = () => false): ActionFacts {
  const there: Record<DropView, (r: Row) => boolean> = {
    starred: (r) => r.starred,
    archive: (r) => r.inInbox !== undefined && placeOf(r) !== "inbox" && !onTop(r.id),
    // spam already in Trash stays there marked; marking it again changes nothing
    spam: (r) => r.inInbox !== undefined && (placeOf(r) === "spam" || (!!r.inTrash && !!r.hasSpam)),
    trash: (r) => r.inInbox !== undefined && placeOf(r) === "trash",
  };
  const notYet = (view: DropView) => narrow(DROP_ACTIONS[view], rows.filter((r) => !there[view](r)).map((r) => r.id));
  // ✓ only where it's truly in that place (Archive refuses what's in Spam or Trash: it can't take it there)
  const all = (view: DropView, place: ReturnType<typeof placeOf> | null) => rows.length > 0 && rows.every((r) => there[view](r) && (place === null || placeOf(r) === place));
  return {
    accounts: new Set(rows.map((r) => r.accountId)),
    fits: { starred: notYet("starred"), archive: notYet("archive"), spam: notYet("spam"), trash: notYet("trash") },
    already: { starred: all("starred", null), archive: all("archive", "archive"), spam: all("spam", null), trash: all("trash", null) },
  };
}

const otherAccount = (facts: ActionFacts, accountId: number | null) => accountId !== null && (facts.accounts.size !== 1 || !facts.accounts.has(accountId));

/** How the target takes these rows: another account's place or nothing it can do refuses; nothing left to do is ✓. */
export function actionDropState(facts: ActionFacts, target: { view: DropView; accountId: number | null }): DropState {
  if (otherAccount(facts, target.accountId)) return "refused";
  if (facts.fits[target.view].length > 0) return "over";
  return facts.already[target.view] ? "already" : "refused";
}

/** Why a refused target took nothing, said when one is dropped there anyway. */
export function actionRefusal(facts: ActionFacts, target: { view: DropView; accountId: number | null }): string {
  const place = viewLabel(target.view);
  if (otherAccount(facts, target.accountId)) return t("sidebar.drop.refusedAccount", { place });
  // Trash and Starred take anything; Spam refuses only in a search, where its button skips what's in Trash (plan 64)
  return target.view === "spam" ? t("sidebar.drop.refusedSpam") : t("sidebar.drop.refusedArchive");
}
