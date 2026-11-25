import type { ThreadAction } from "./types";

/**
 * Plan 86: Gmail's inbox tabs, and plan 275 Outlook's Focused Inbox. A message's category as a number (the flag
 * protocol's `category` field); null: a message of a kind without them (IMAP, a local copy), never tabbed and never
 * sent a category op. Gmail's are its CATEGORY_* labels; Outlook's are Primary (focused) and 6 Other (other), which has
 * no Gmail label (`""`).
 */
export const CATEGORY_LABELS = ["", "CATEGORY_PERSONAL", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", ""] as const;
export type MessageCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const CAT_NONE = 0;
export const CAT_PERSONAL = 1;
export const CAT_PROMOTIONS = 2;
export const CAT_SOCIAL = 3;
/** plan 275: Outlook's Focused Inbox "Other" */
export const CAT_OTHER = 6;

/** The tabs Terno separates (Gmail's Updates and Forums stay in the Inbox); each account kind has its own (`tabsOf`). */
export const TABS = ["promotions", "social", "other"] as const;
export type Tab = (typeof TABS)[number];
/** threads.tab: 0 the Inbox (Primary, Focused), else the tab */
export const TAB_CODE: Record<Tab, 1 | 2 | 3> = { promotions: 1, social: 2, other: 3 };
export const tabOfCode = (code: number): Tab | null => (code === 1 ? "promotions" : code === 2 ? "social" : code === 3 ? "other" : null);
/** the category that puts a message in each tab */
const TAB_CATEGORY: Record<Tab, MessageCategory> = { promotions: CAT_PROMOTIONS, social: CAT_SOCIAL, other: CAT_OTHER };

/** Plan 275: the tabs an account's kind has (Gmail's two, Outlook's Other, none for IMAP). */
export function tabsOf(kind: string): readonly Tab[] {
  return kind === "gmail" ? GMAIL_TABS : kind === "outlook" ? OUTLOOK_TABS : [];
}
const GMAIL_TABS = ["promotions", "social"] as const satisfies readonly Tab[];
const OUTLOOK_TABS = ["other"] as const satisfies readonly Tab[];

// the order a message carrying two (never seen; Gmail gives one) is read in: the tabs first (6 is never a label)
const PRECEDENCE: readonly MessageCategory[] = [2, 3, 4, 5, 1];

/** A message's category from its Gmail labels; null without labels (not Gmail, or a local copy). */
export function categoryOf(labels: readonly string[] | null | undefined): MessageCategory | null {
  if (!labels) return null;
  for (const c of PRECEDENCE) if (labels.includes(CATEGORY_LABELS[c])) return c;
  return CAT_NONE;
}

/** The same from the stored JSON text (`messages.gmail_labels`). */
export function categoryOfJson(json: string | null | undefined): MessageCategory | null {
  if (json == null) return null;
  for (const c of PRECEDENCE) if (json.includes(`"${CATEGORY_LABELS[c]}"`)) return c;
  return CAT_NONE;
}

/** The actions that set a message's category, by the category they set. */
export const CATEGORY_ACTIONS = {
  toNoCategory: 0,
  toPrimary: 1,
  toPromotions: 2,
  toSocial: 3,
  toUpdates: 4,
  toForums: 5,
  toOther: 6,
} as const satisfies Partial<Record<ThreadAction, MessageCategory>>;
export type CategoryAction = keyof typeof CATEGORY_ACTIONS;
export const isCategoryAction = (a: string): a is CategoryAction => Object.hasOwn(CATEGORY_ACTIONS, a);
export const categoryAction = (c: MessageCategory): CategoryAction => (Object.keys(CATEGORY_ACTIONS) as CategoryAction[]).find((k) => CATEGORY_ACTIONS[k] === c)!;
/** The user's moves: to the Inbox, to a tab */
export const TAB_ACTION: Record<Tab, CategoryAction> = { promotions: "toPromotions", social: "toSocial", other: "toOther" };

/**
 * Plan 275 (Codex critique #5): the categories each account kind's messages take, so an action of another kind's is
 * never applied to them (Gmail's labels, Outlook's focused and other); null for a kind without any.
 */
export function categoriesOf(kind: string): ReadonlySet<MessageCategory> | null {
  return kind === "gmail" ? GMAIL_CATEGORIES : kind === "outlook" ? OUTLOOK_CATEGORIES : null;
}
const GMAIL_CATEGORIES: ReadonlySet<MessageCategory> = new Set([0, 1, 2, 3, 4, 5]);
const OUTLOOK_CATEGORIES: ReadonlySet<MessageCategory> = new Set([CAT_PERSONAL, CAT_OTHER]);
/** a tabbed category: the one each tab's messages carry, by tab code */
export const tabOfCategory = (category: number | null): 0 | 1 | 2 | 3 => (category === CAT_PROMOTIONS ? 1 : category === CAT_SOCIAL ? 2 : category === CAT_OTHER ? 3 : 0);

/** What the tab rule reads of a message. */
export interface TabMessage {
  id: number;
  date: number;
  category: number | null;
  in_inbox: number;
  is_trash: number;
  is_spam: number;
  is_sent: number;
  is_draft: number;
}

/**
 * Which tab a thread is in (plan 86): 0 when any message of someone else's in
 * the Inbox is not Promotions or Social (Primary wins: hiding wrongly loses
 * mail), else the newest such message's tab. `own`: the message is from one
 * of your addresses (sent mail is yours already).
 *
 * `onlyYours` (plan 256): none of its Inbox mail is someone else's, so no tab
 * can take it whatever its categories (a note to yourself): no tab move is offered.
 */
export function threadTabState(messages: Iterable<TabMessage>, own?: (m: TabMessage) => boolean): { tab: 0 | 1 | 2 | 3; onlyYours: boolean } {
  let newest: TabMessage | null = null;
  for (const m of messages) {
    if (!m.in_inbox || m.is_trash || m.is_spam || m.is_sent || m.is_draft || own?.(m)) continue;
    if (tabOfCategory(m.category) === 0) return { tab: 0, onlyYours: false };
    if (!newest || m.date > newest.date || (m.date === newest.date && m.id > newest.id)) newest = m;
  }
  return { tab: !newest ? 0 : tabOfCategory(newest.category), onlyYours: !newest };
}

export const threadTab = (messages: Iterable<TabMessage>, own?: (m: TabMessage) => boolean): 0 | 1 | 2 | 3 => threadTabState(messages, own).tab;

/** Plan 86, 275: an account separates its tabs unless the user turned it off (Gmail's and Outlook's). */
export const separatesTabs = (account: { kind: string; separateTabs?: boolean }) => tabsOf(account.kind).length > 0 && account.separateTabs !== false;
/** Plan 275: whether this tab is one of the account's (a tab list, a scope, a move to it) */
export const hasTab = (kind: string, tab: Tab) => tabsOf(kind).includes(tab);
/** the category each tab's messages carry */
export const categoryOfTab = (tab: Tab): MessageCategory => TAB_CATEGORY[tab];
