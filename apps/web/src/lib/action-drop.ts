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

type Row = Pick<ThreadSummary, "id" | "accountId" | "starred" | "inInbox" | "inSpam" | "inTrash">;

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
 * never there yet: the backend decides.
 */
export function actionFacts(rows: readonly Row[], narrow: Narrow = (_, ids) => ids): ActionFacts {
  const known = rows.every((r) => r.inInbox !== undefined);
  const notYet = (there: (r: Row) => boolean) => rows.filter((r) => r.inInbox === undefined || !there(r)).map((r) => r.id);
  return {
    accounts: new Set(rows.map((r) => r.accountId)),
    fits: {
      starred: narrow("star", rows.filter((r) => !r.starred).map((r) => r.id)),
      archive: narrow("archive", notYet((r) => placeOf(r) !== "inbox")),
      spam: narrow("spam", notYet((r) => placeOf(r) === "spam")),
      trash: narrow("trash", notYet((r) => placeOf(r) === "trash")),
    },
    already: {
      starred: rows.length > 0 && rows.every((r) => r.starred),
      archive: known && rows.every((r) => placeOf(r) === "archive"),
      spam: known && rows.every((r) => placeOf(r) === "spam"),
      trash: known && rows.every((r) => placeOf(r) === "trash"),
    },
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
