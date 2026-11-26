import { personItemId, personKey, type PeopleList, type PersonItem, type PersonPage } from "@terno/core";
import { t } from "@terno/i18n";
import { RpcError } from "@terno/core/rpc";
import type { LeftRows } from "~/lib/actions";
import { aiFeaturesOffered } from "~/lib/ai";
import { actOnTask, taskOf } from "~/lib/dated";
import { actOnFollowup } from "~/lib/followups";
import { morph } from "~/lib/morph";
import { closePage, currentPage, listLayout, openThread } from "~/lib/page";
import { noteOpen } from "~/lib/reminders";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, navigate, setApp, useApp } from "~/state/app";
import { peopleRows, usePeople, type PeopleRow } from "~/state/people";
import { loadThread } from "~/state/threads";

/**
 * Plan 281: People's ways in and out, its reads and its acts. The list and the page are read when People opens and again
 * when What matters or mail changes (`todayChanged`, `changed`): nothing is polled. A change an act or its Undo made is
 * drawn as one morph (plan 251): the item leaves the page, the items under it glide up, and the person's row in the list
 * moves to its new place (from Open into Everyone when it was their last), together.
 */

/** an act's change is owed motion until this moment: the next answers to arrive morph */
let owedUntil = 0;
const OWED_MS = 2000;
const owe = () => (owedUntil = Date.now() + OWED_MS);
const owed = () => Date.now() < owedUntil;

/**
 * A change drawn as one morph when an act owes it, else at once. `still` is asked again when the change is made: a morph
 * makes it a frame later, when a newer read or another person may have taken its place.
 */
function draw(update: () => void, moving: boolean, still: () => boolean): void {
  const guarded = () => {
    if (still()) update();
  };
  if (moving) morph(guarded);
  else guarded();
}

/** The sidebar's People: the view, its list read (the selected person's page with it). */
export function openPeople(): void {
  navigate({ people: true });
  void loadPeople();
}

let listSeq = 0;
let waitingForIndex = false;

/** Reads the list (Open, Everyone); while the index is being made ready, one call waits for it, then the list (and a search) reads again. */
export async function loadPeople(): Promise<void> {
  const mine = ++listSeq;
  const moving = owed();
  const current = () => mine === listSeq && getApp().people;
  try {
    const list = await client.call("people.list", {});
    if (!current()) return;
    draw(() => usePeople.setState({ list, failed: false }), moving, current);
    if (list.index === "warming") waitForIndex();
  } catch {
    // said where the list is, with a way to try again; what was shown stays
    if (current()) usePeople.setState({ failed: true });
  }
}

function waitForIndex(): void {
  if (waitingForIndex) return;
  waitingForIndex = true;
  void client
    .call("people.ready", {})
    .then(() => {
      if (!getApp().people) return;
      void loadPeople();
      // a name typed while the contacts were getting ready is looked for again
      const { query } = usePeople.getState();
      if (query.trim()) searchPeople(query);
    })
    .catch(() => {})
    .finally(() => (waitingForIndex = false));
}

let searchSeq = 0;

/** What's typed in the list's field: names and addresses only, answered as it's typed (a late answer is dropped). */
export function searchPeople(query: string): void {
  const mine = ++searchSeq;
  usePeople.setState({ query, ...(query.trim() ? {} : { hits: null }) });
  if (!query.trim()) return;
  client.call("people.search", { query }).then(
    (hits) => {
      if (mine !== searchSeq) return;
      usePeople.setState({ hits });
      if (hits.index === "warming") waitForIndex();
    },
    (error: unknown) => {
      if (!(error instanceof RpcError && error.code === "CANCELLED") && mine === searchSeq) usePeople.setState({ hits: { hits: [], index: "ready" } });
    },
  );
}

let pageSeq = 0;

/** Selects a person: their page shows (the reader in Split, the list's pane in List), read now (again, if it didn't come). */
export function selectPerson(key: string, email: string): void {
  const s = getApp();
  if (s.person === key && s.selectedId === null && usePeople.getState().page?.key === key) return;
  setApp({ person: key, selectedId: null, anchorId: null, readerOpen: false });
  void loadPage(key, email);
}

/** Back from a person's page in List (its "‹ People" and Esc): the list again, where it was. */
export function leavePerson(): void {
  if (getApp().person === null) return;
  pageSeq++;
  opening++;
  setApp({ person: null, selectedId: null, anchorId: null });
  usePeople.setState({ page: null, reading: null, pageFailed: null });
}

async function loadPage(key: string, email: string): Promise<void> {
  const mine = ++pageSeq;
  const moving = owed();
  const current = () => mine === pageSeq && getApp().people && getApp().person === key;
  const shown = usePeople.getState().page;
  usePeople.setState({ reading: { key, email }, pageFailed: null, ...(shown?.key === key ? {} : { page: null }) });
  try {
    const page = await client.call("people.person", { email });
    if (!current()) return;
    draw(() => usePeople.setState({ page, reading: null }), moving, current);
  } catch {
    if (mine === pageSeq) usePeople.setState({ reading: null, pageFailed: { key, email } });
  }
}

/** The selected person's page, read again (an act's answer, a change of mail): only an address of theirs is asked for. */
function reloadPage(): void {
  const s = getApp();
  const p = usePeople.getState();
  const email = p.page?.key === s.person ? p.page.email : p.reading?.key === s.person ? p.reading.email : null;
  if (s.people && s.person !== null && email) void loadPage(s.person, email);
}

/** Tries the page that didn't come again. */
export function retryPage(): void {
  const s = getApp();
  const { pageFailed } = usePeople.getState();
  if (s.person !== null && pageFailed?.key === s.person) void loadPage(s.person, pageFailed.email);
}

let opening = 0;

/**
 * Where a person's page was left (its scroll, the line a conversation was opened from), by person: coming back to it
 * from that conversation finds it there, the keyboard back on that line.
 */
export const pagePlaces = new Map<string, { top: number; from: string | null }>();
const PLACES_MAX = 50;

/** Notes where a person's page is, before a conversation takes its place. */
export function notePagePlace(key: string, top: number, from: string | null): void {
  pagePlaces.delete(key);
  pagePlaces.set(key, { top, from });
  if (pagePlaces.size > PLACES_MAX) pagePlaces.delete(pagePlaces.keys().next().value!);
}

/**
 * An item or a conversation on a person's page opens its conversation: read first, then shown in one change (never an
 * empty reader); one that can't be read says so and the page stays; a newer click, another person or leaving People
 * meanwhile opens nothing.
 */
export function openFromPerson(threadId: number): void {
  const mine = ++opening;
  const person = getApp().person;
  void loadThread(threadId).then((detail) => {
    const s = getApp();
    if (mine !== opening || !s.people || s.person !== person) return;
    if (!detail) return void snack.error(t("people.openFailed"));
    noteOpen(threadId);
    openThread(threadId);
  });
}

/** Esc and the reader's Close on a conversation opened from a person's page (Split): their page again. */
export function closePersonConversation(): boolean {
  const s = getApp();
  if (!s.people || s.selectedId === null || listLayout()) return false;
  opening++;
  setApp({ selectedId: null, anchorId: null });
  return true;
}

/**
 * Done, Remove and Later on an item of a person's page: What matters' own acts (one snack, one exact Undo), a reply owed to
 * you through follow-ups'. Done and Remove take the item off the page and off the person's row at once, in one morph (their
 * last: the row falls into its place in Everyone); Later keeps it (it's still open, further on): the answer moves it.
 */
export async function actOnPersonItem(item: PersonItem, action: "done" | "dismiss" | "later", at?: number): Promise<void> {
  owe();
  const left = action === "later" ? afterAnswer() : takeOff(item);
  if (item.kind === "awaiting") return actOnFollowup(item.row, action, at, left);
  const task = taskOf(item.item.why, Date.now(), item.item.thread);
  if (task) await actOnTask(task, action, at, left);
}

/** Undo owes motion too: what comes back glides in. A failure reads the truth again (another act may have landed meanwhile). */
function afterAnswer(): LeftRows {
  return {
    async undo(run) {
      owe();
      await run();
    },
    failed: () => {
      void loadPeople();
      reloadPage();
    },
  };
}

/** The item leaves the page and its person's row now, in one morph. */
function takeOff(item: PersonItem): LeftRows {
  const id = personItemId(item);
  const key = usePeople.getState().page?.key;
  morph(() => usePeople.setState(({ page, list }) => ({ page: page && page.key === key ? withoutItem(page, id) : page, list: list && withoutListItem(list, id) })));
  return afterAnswer();
}

export const withoutItem = (page: PersonPage, id: string): PersonPage => ({ ...page, items: page.items.filter((i) => personItemId(i) !== id) });

/** The list without an item: its person's row says their next one, or (none left) leaves Open for their place in Everyone. */
export function withoutListItem(list: PeopleList, id: string): PeopleList {
  const open = list.open.flatMap((p) => {
    if (!p.items.some((i) => personItemId(i) === id)) return [p];
    const items = p.items.filter((i) => personItemId(i) !== id);
    return items.length ? [{ ...p, items }] : [];
  });
  return { ...list, open };
}

const morphIds = new Map<string, number>();
/**
 * A view-transition name for a person's row (`p`) or a page's item (`i`): a short stable one per key for the session (a key
 * is an address, never a CSS name), so the same person is the same element across a morph.
 */
export function morphName(kind: "p" | "i", key: string): string {
  const id = `${kind}:${key}`;
  let n = morphIds.get(id);
  if (n === undefined) morphIds.set(id, (n = morphIds.size));
  return `people-${kind}${n}`;
}

/** What the list component registers: its rows as drawn, bringing a person's row into view (and the keyboard to it), its search field. */
export const peopleList: { rows?: () => readonly PeopleRow[]; toKey?: (key: string, focus: boolean) => void; focusSearch?: () => void } = {};

/** j/k in People: the next (or previous) person, their page with them; no motion (a key pressed many times a day). */
export function movePerson(delta: number): void {
  const { list, query, hits } = usePeople.getState();
  // the rows as drawn (memoized by the list), headings stepped over
  const people = (peopleList.rows?.() ?? peopleRows(list, query, hits, personKey)).filter((r): r is Extract<PeopleRow, { kind: "person" }> => r.kind === "person");
  if (!people.length) return;
  const at = people.findIndex((r) => r.id === getApp().person);
  const row = people[at < 0 ? (delta > 0 ? 0 : people.length - 1) : Math.max(0, Math.min(people.length - 1, at + delta))]!;
  // the keyboard on a row goes along with the selection
  const focus = document.activeElement?.getAttribute("data-testid") === "person-row";
  selectPerson(row.key, row.email);
  peopleList.toKey?.(row.key, focus);
}

/** Opens People on someone (the person menu's "Open in People"): the view, then their page. */
export function openInPeople(email: string): void {
  if (!getApp().people) openPeople();
  selectPerson(personKey(email), email);
}

/**
 * `/` and the palette's search in People: its field, where it can be reached. In List, a conversation over the list and
 * a person's page over it give way first (the field is the list's).
 */
export function focusPeopleSearch(): void {
  if (listLayout()) {
    if (currentPage() !== "list") closePage();
    leavePerson();
  }
  requestAnimationFrame(() => peopleList.focusSearch?.());
}

/**
 * The person card's reads (the chip's menu): asked for on the chip's hover or focus, kept per person and conversation until
 * What matters or mail changes, so the menu opens with its head at once, or (asked only on the click) within
 * `CARD_WAIT_MS`, else without it.
 */
const cards = new Map<string, { page: PersonPage | null; ready: Promise<PersonPage | null> }>();
export const CARD_WAIT_MS = 250;
const cardKey = (email: string, threadId: number) => `${personKey(email)}\n${threadId}`;

/** Starts reading someone's card beside a conversation (nothing while AI features aren't offered). */
export function prefetchCard(email: string, threadId: number): Promise<PersonPage | null> {
  const key = cardKey(email, threadId);
  const had = cards.get(key);
  if (had) return had.ready;
  if (!aiFeaturesOffered(getApp())) return Promise.resolve(null);
  const entry: { page: PersonPage | null; ready: Promise<PersonPage | null> } = { page: null, ready: Promise.resolve(null) };
  entry.ready = client.call("people.person", { email, conversations: 2, except: threadId }).then(
    (page) => (entry.page = page),
    () => {
      cards.delete(key);
      return null;
    },
  );
  cards.set(key, entry);
  return entry.ready;
}

/** The card as read so far: null until it answers. */
export const cardOf = (email: string, threadId: number): PersonPage | null => cards.get(cardKey(email, threadId))?.page ?? null;

/** Waits for the card at most `CARD_WAIT_MS` (the menu's open never waits longer). */
export async function cardWithin(email: string, threadId: number): Promise<PersonPage | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), CARD_WAIT_MS)));
  try {
    return await Promise.race([prefetchCard(email, threadId), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What People shows, read again: the list, the page, a search's counts. */
function reread(): void {
  void loadPeople();
  reloadPage();
  const { query } = usePeople.getState();
  if (query.trim()) searchPeople(query);
}

/** At boot: People reads again when What matters or mail changes, only while it shows; the cards are read again when asked. */
export function installPeople(): void {
  client.on("todayChanged", () => {
    cards.clear();
    if (getApp().people) reread();
  });
  // a conversation moved (to Trash, back, answered): what's open may have changed, and the page's conversations
  client.on("changed", () => {
    cards.clear();
    if (getApp().people) reread();
  });
  // AI features no longer offered: People goes (its row too), back to the Inbox; the cards read go with it
  useApp.subscribe((s, prev) => {
    if (!aiFeaturesOffered(prev) || aiFeaturesOffered(s)) return;
    cards.clear();
    if (s.people) navigate({ view: "inbox" });
  });
}
