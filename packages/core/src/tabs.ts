import type { ThreadAction } from "./types";

/**
 * Plan 86: Gmail's inbox tabs. A Gmail message's category label as a number
 * (the flag protocol's `category` field); null: not a Gmail message, never
 * tabbed and never sent a category op.
 */
export const CATEGORY_LABELS = ["", "CATEGORY_PERSONAL", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"] as const;
export type MessageCategory = 0 | 1 | 2 | 3 | 4 | 5;
export const CAT_NONE = 0;
export const CAT_PERSONAL = 1;
export const CAT_PROMOTIONS = 2;
export const CAT_SOCIAL = 3;

/** The tabs Terno separates (Updates and Forums stay in the Inbox). */
export const TABS = ["promotions", "social"] as const;
export type Tab = (typeof TABS)[number];
/** threads.tab: 0 the Inbox (Primary), else the tab */
export const TAB_CODE: Record<Tab, 1 | 2> = { promotions: 1, social: 2 };
export const tabOfCode = (code: number): Tab | null => (code === 1 ? "promotions" : code === 2 ? "social" : null);

// the order a message carrying two (never seen; Gmail gives one) is read in: the tabs first
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
} as const satisfies Partial<Record<ThreadAction, MessageCategory>>;
export type CategoryAction = keyof typeof CATEGORY_ACTIONS;
export const isCategoryAction = (a: string): a is CategoryAction => Object.hasOwn(CATEGORY_ACTIONS, a);
export const categoryAction = (c: MessageCategory): CategoryAction => (Object.keys(CATEGORY_ACTIONS) as CategoryAction[]).find((k) => CATEGORY_ACTIONS[k] === c)!;
/** The user's moves: to the Inbox, to a tab */
export const TAB_ACTION: Record<Tab, CategoryAction> = { promotions: "toPromotions", social: "toSocial" };

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
 */
export function threadTab(messages: Iterable<TabMessage>, own?: (m: TabMessage) => boolean): 0 | 1 | 2 {
  let newest: TabMessage | null = null;
  for (const m of messages) {
    if (!m.in_inbox || m.is_trash || m.is_spam || m.is_sent || m.is_draft || own?.(m)) continue;
    if (m.category !== CAT_PROMOTIONS && m.category !== CAT_SOCIAL) return 0;
    if (!newest || m.date > newest.date || (m.date === newest.date && m.id > newest.id)) newest = m;
  }
  return !newest ? 0 : newest.category === CAT_PROMOTIONS ? 1 : 2;
}

/** Plan 86: an account separates its tabs unless the user turned it off (Gmail only). */
export const separatesTabs = (account: { kind: string; separateTabs?: boolean }) => account.kind === "gmail" && account.separateTabs !== false;
