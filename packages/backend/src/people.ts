import { addressKey, addressOnly, isPersonRequest, PEOPLE_EVERYONE_MAX, PEOPLE_SEARCH_MAX, PERSON_CONVERSATIONS_MAX, peopleSince, personItemThread, personKey, personItemAhead, personSince, senderIsPerson, sortPeopleOpen, sortPersonItems, type FollowupRow, type PeopleFilter, type PeopleList, type PeopleSearch, type PersonItem, type PersonOpen, type PersonPage, type ThreadSummary, type TodayItem } from "@terno/core";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";


/**
 * Plan 281: People. What's open between the user and each person, grouped from what What matters already decided (its
 * open part: your promises, conversations waiting on your answer, a person's requests) and the replies owed to you (the
 * follow-ups waiting on them); everyone you've written to and the search, from the recipient index. Nothing at all while
 * What matters isn't offered (its own rule, asked first by every call). The grouping is kept while What matters and the
 * index are as they were, and read again on the next ask after either changes: no timer, nothing done while nobody asks.
 */
export class PeopleService {
  private cache: { today: number; index: number; owed: boolean; rules: number; open: Promise<PersonOpen[]> } | null = null;
  /** plan 278's rules (your word on who is a person), read once per change of them */
  private rules: { at: number; map: Promise<ReadonlyMap<string, boolean>> } | null = null;
  private rulesAt = 0;
  /**
   * Everyone's version as the renderer holds it, per filter (plan 287: two windows on two filters don't make each other
   * send it again): the index (which one, and its scores) and the rules; each changes who's in it.
   */
  private readonly everyoneAt = new Map<string, { index: string; rules: number; version: number }>();
  private versions = 0;
  /** an identity per index object (a rebuilt index may count its scores from where an old one was) */
  private readonly indexIds = new WeakMap<object, number>();

  constructor(private readonly b: Backend) {}

  /**
   * Open and Everyone. Everyone needs the index: started here (as a recipient field starts it), never waited for; sent only
   * when it isn't the version the renderer holds (`known`).
   */
  async list(known?: number, filter?: PeopleFilter): Promise<PeopleList> {
    if (!(await this.b.today.offered())) return { open: [], everyone: [], everyoneVersion: -1, index: "ready" };
    void this.b.warmAutocomplete().catch(() => {});
    const scope = await this.scope(filter);
    const open = this.within(await this.open(), scope);
    const index = this.b.autocomplete.peopleIndex();
    if (!index) return { open, everyone: [], everyoneVersion: -1, index: this.indexState() };
    const held = this.everyoneAt.get(scope.key);
    if (held && held.index === this.indexAt(index) && held.rules === this.rulesAt && known === held.version) return { open, everyoneVersion: held.version, index: "ready" };
    const mine = await this.mine();
    // (each written to: no correspondents to look up; the rules as they were when asked, so a change meanwhile isn't
    // stamped on a list made without it, Codex code review)
    const rules = this.rulesAt;
    const person = await this.isPerson([]);
    // one person under two spellings once, and never you, nor a sender that isn't a person; the open people are in it too,
    // each at their place, so one whose last item goes falls into it there (the list leaves them out while they're open)
    const seen = new Set<string>();
    const everyone = [];
    for (const p of index.written(PEOPLE_EVERYONE_MAX * 2, scope.index)) {
      const key = personKey(p.email);
      if (seen.has(key) || mine.has(key) || !person(p.email)) continue;
      seen.add(key);
      everyone.push({ ...p, key });
      if (everyone.length === PEOPLE_EVERYONE_MAX) break;
    }
    // (named as it was read: the index and the rules after the awaits above, so a change meanwhile reads again next time)
    const at = { index: this.indexAt(index), rules };
    const was = this.everyoneAt.get(scope.key);
    const version = was && was.index === at.index && was.rules === at.rules ? was.version : ++this.versions;
    this.everyoneAt.delete(scope.key);
    this.everyoneAt.set(scope.key, { ...at, version });
    if (this.everyoneAt.size > EVERYONE_FILTERS) this.everyoneAt.delete(this.everyoneAt.keys().next().value!);
    return { open, everyone, everyoneVersion: version, index: "ready" };
  }

  /** Resolves when the index has answered (or given up): the list reads again then. One call, nothing polled. */
  async ready(): Promise<{ index: PeopleList["index"] }> {
    if (!(await this.b.today.offered())) return { index: "ready" };
    await this.b.warmAutocomplete().catch(() => {});
    return { index: this.indexState() };
  }

  /** Names and addresses only, never content; each hit with how many things are open with them. */
  async search(query: string, filter?: PeopleFilter): Promise<PeopleSearch> {
    if (!(await this.b.today.offered())) return { hits: [], index: "ready" };
    const index = this.b.autocomplete.peopleIndex();
    if (!index) return { hits: [], index: this.indexState() };
    const now = this.b.now();
    const scope = await this.scope(filter);
    // (each hit's count is what's open with them in the filter's accounts, as their row and page say it)
    const open = new Map(this.within(await this.open(), { ...scope, since: 0, until: 0 }).map((p) => [p.key, p.items.filter((i) => openNow(i, now)).length]));
    const mine = await this.mine();
    // (asked for more than are shown: senders that aren't people are left out after)
    const found = index.people(query, PEOPLE_SEARCH_MAX * 4, scope.index);
    const person = await this.isPerson(found.map((h) => h.email));
    const seen = new Set<string>();
    const hits = [];
    for (const h of found) {
      const key = personKey(h.email);
      if (mine.has(key) || seen.has(key) || !person(h.email)) continue;
      seen.add(key);
      hits.push({ ...h, key, open: open.get(key) ?? 0 });
      if (hits.length === PEOPLE_SEARCH_MAX) break;
    }
    return { hits, index: "ready" };
  }

  /**
   * One person: what's open, their recent conversations (newest first, never Spam or Trash). For the card (`except`, the
   * conversation open beside it): the newest other one's stored summary, its "Last time"; the page reads none.
   */
  async person(email: string, conversations = PERSON_CONVERSATIONS_MAX, except?: number, filter?: PeopleFilter): Promise<PersonPage | null> {
    if (!(await this.b.today.offered())) return null;
    const key = personKey(email);
    // you're never a person here
    if ((await this.mine()).has(key)) return null;
    // plan 287: the page is the person whole in the filter's accounts (its date chooses who's listed, not what they show)
    const scope = await this.scope({ accounts: filter?.accounts });
    const found = this.within(await this.open(), scope).find((p) => p.key === key);
    const want = Math.max(0, Math.min(conversations, PERSON_CONVERSATIONS_MAX));
    // the address as it was seen (the search is exact on it), All Mail: Spam and Trash are left out by the store
    const page = want ? await this.conversations(email, want, scope.accounts) : null;
    const shown = page?.items ?? [];
    // which of them they wrote in (the rest, a group email they were only on): theirs are a subset, newest first by the
    // same date, so the newest `want` of theirs hold every one of these they wrote
    const wrote = want > 0 && shown.length > 0 ? await this.wroteIn(email, want, shown, scope.accounts) : undefined;
    const name = this.b.autocomplete.peopleIndex()?.person(email)?.name || found?.name || "";
    // the card's last time you wrote each other (r06): the newest other conversation they wrote in, or whose last message
    // is yours (to them); never a group email someone else wrote that they were only on
    const mine = await this.mine();
    const theirs = new Set(wrote);
    const last = except === undefined ? undefined : shown.find((t) => t.id !== except && (theirs.has(t.id) || mine.has(personKey(t.fromEmail))));
    const lastSummary = last ? (await this.b.today.summaryLine(last.id)).summary : undefined;
    // (the card says who wrote it: you, them, or someone else on it)
    const lastFromMe = last ? mine.has(personKey(last.fromEmail)) : false;
    return {
      key,
      email,
      name,
      items: found?.items ?? [],
      conversations: shown,
      more: page?.more === true,
      ...(last ? { lastBetween: last.id } : {}),
      ...(last && lastSummary ? { lastSummary, lastSummaryOf: last.id } : {}),
      ...(lastFromMe ? { lastFromMe } : {}),
      ...(wrote ? { wrote } : {}),
    };
  }

  private async wroteIn(email: string, want: number, shown: readonly ThreadSummary[], accounts: readonly number[] | null): Promise<number[]> {
    // the address as it was seen, as the page's own search has it (a +tag is another sender's address to the store)
    const address = email.trim().toLowerCase();
    if (!address.includes("@") || /[\s"]/.test(address)) return shown.map((t) => t.id);
    const theirs = await this.conversations(`from:${address}`, want, accounts);
    const ids = new Set(theirs.items.map((t) => t.id));
    return shown.filter((t) => ids.has(t.id)).map((t) => t.id);
  }

  /**
   * Each address's last conversation, by its date (0: none): the page's own read (its newest conversation, never in Spam or
   * Trash), so a row's "Last email" and the page's are one date. One indexed search each, only the rows drawn.
   */
  async lastEmails(emails: readonly string[], filter?: PeopleFilter): Promise<{ last: Record<string, number> }> {
    if (!(await this.b.today.offered())) return { last: {} };
    // plan 287: in the filter's accounts, as the page reads them
    const { accounts } = await this.scope({ accounts: filter?.accounts });
    const last: Record<string, number> = {};
    for (const email of new Set(emails)) last[email] = (await this.conversations(email, 1, accounts)).items[0]?.lastDate ?? 0;
    return { last };
  }

  /** Plan 287: the newest conversations a search finds (never in Spam or Trash), in the filter's accounts: one search. */
  private async conversations(query: string, limit: number, accounts: readonly number[] | null): Promise<{ items: ThreadSummary[]; more: boolean }> {
    const page = await this.b.store.threads.searchText({ query, place: "all", limit, now: this.b.now(), ...(accounts ? { accountIds: accounts } : {}) });
    return { items: page.items, more: page.nextCursor != null };
  }

  /**
   * Plan 287: a filter as People applies it: the accounts that still exist (none left: every account, as an empty choice
   * is), the oldest last email it lets in, and the index's form of both. `key` names it for Everyone's version.
   */
  private async scope(filter: PeopleFilter | undefined): Promise<Scope> {
    // the cutoff by the hour: Everyone's list, its cache and its version are of one cutoff (Codex code review); a custom
    // range's days are its own
    const exact = filter?.range ? 0 : peopleSince(filter?.within, this.b.now());
    const since = filter?.range ? filter.range.from : exact ? Math.floor(exact / HOUR) * HOUR : 0;
    const until = filter?.range?.to ?? 0;
    let accounts: number[] | null = null;
    if (filter?.accounts?.length) {
      const ids = new Set((await this.b.store.accounts.list()).map((a) => a.id));
      const kept = [...new Set(filter.accounts)].filter((id) => ids.has(id)).sort((a, b) => a - b);
      accounts = kept.length ? kept : null;
    }
    const key = `${accounts?.join(",") ?? ""}|${since}|${until}`;
    return { accounts, since, until, key, index: { ...(accounts ? { accounts } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) } };
  }

  /**
   * Plan 287: Open within a filter, from the grouping as it is (never changed: every filter reads the one cache). By
   * account, each person's items whose conversation is in one of them (who has none left isn't in it); by date, whose last
   * email (in those accounts) is recent enough: the index's date, else their items' newest conversation.
   */
  private within(open: PersonOpen[], scope: Pick<Scope, "accounts" | "since"> & { until?: number }): PersonOpen[] {
    const { accounts, since, until = 0 } = scope;
    if (!accounts && !since && !until) return open;
    const index = this.b.autocomplete.peopleIndex();
    const now = this.b.now();
    const inAccounts = accounts ? new Set(accounts) : null;
    const out: PersonOpen[] = [];
    let changed = false;
    for (const p of open) {
      const kept = inAccounts ? p.items.filter((i) => inAccounts.has(personItemThread(i).accountId)) : p.items;
      // (one the index doesn't know, or not yet, is kept: their date is unknown)
      // (unknown to the index, or not in these accounts by it: kept, their date unknown)
      const last = since || until ? index?.lastWith(p.email, accounts ?? undefined) : null;
      if (!kept.length || (last && ((since && last < since) || (until && last > until)))) {
        changed = true;
        continue;
      }
      // (the items keep their order: since is read again only when some went)
      if (kept.length === p.items.length) out.push(p);
      else {
        changed = true;
        out.push({ ...p, items: kept, since: personSince(kept, now) });
      }
    }
    return changed ? sortPeopleOpen(out, now) : open;
  }

  /** Plan 278's rules changed: who is a person may have (the grouping and the lists read them again). */
  rulesChanged(): void {
    this.rulesAt++;
  }

  /**
   * Who counts as a person in People (plan 278's rule on an address alone): never a sender of mail marked as spam, then your
   * word on them, then the guesses (a no-reply, a role or service address, only when you've written to it).
   */
  private async isPerson(emails: Iterable<string>): Promise<((email: string) => boolean) & { written: (email: string) => boolean }> {
    if (this.rules?.at !== this.rulesAt) {
      const map = this.b.store.facts.rules.list().then((rules) => new Map(rules.map((r) => [r.key, r.person])));
      this.rules = { at: this.rulesAt, map };
      map.catch(() => {
        if (this.rules?.map === map) this.rules = null;
      });
    }
    const rules = await this.rules.map;
    const index = this.b.autocomplete.peopleIndex();
    // written to by key (plan 17's correspondents, as the facts and the Inbox's filter judge them: `support+ticket@` written
    // is `support@`'s), looked up only for those the index doesn't already say you've written to
    const ask = new Set<string>();
    for (const e of emails) if (index?.person(e)?.written !== true) ask.add(addressKey(e));
    const keys = ask.size ? await this.b.store.dated.written([...ask]) : new Set<string>();
    const written = (email: string) => index?.person(email)?.written === true || keys.has(addressKey(email));
    const person = (email: string) => !index?.spam(email) && senderIsPerson(addressOnly(email), { written: () => written(email), rule: (key) => rules.get(key) });
    return Object.assign(person, { written });
  }

  /** Which index, at which scores: Everyone's version is of this. */
  private indexAt(index: object & { scoreVersion: number }): string {
    let id = this.indexIds.get(index);
    if (id === undefined) this.indexIds.set(index, (id = ++this.versions));
    return `${id}:${index.scoreVersion}`;
  }

  private indexState(): PeopleList["index"] {
    return this.b.autocomplete.peopleIndex() ? "ready" : this.b.autocomplete.gaveUp ? "off" : "warming";
  }

  /** Your own addresses as people keys (the accounts', and every one you've sent from, as the index knows them): never anyone in People. */
  private async mine(): Promise<ReadonlySet<string>> {
    const keys = new Set((await this.b.store.accounts.list()).map((a) => personKey(a.email)));
    for (const email of this.b.autocomplete.peopleIndex()?.ownEmails() ?? []) keys.add(personKey(email));
    return keys;
  }

  /**
   * The grouping, shared by the list, the search's counts and the page until What matters, the index or the follow-ups
   * switch changes (turning follow-ups off or on changes no row, so nothing else says it).
   */
  private async open(): Promise<PersonOpen[]> {
    const today = this.b.today.revision;
    // the index answering, or catching up, changes who a dated item's sender is (someone you've written to) and names
    const index = this.b.autocomplete.peopleIndex()?.scoreVersion ?? -1;
    const owed = (await readSettings(this.b.store)).followups?.enabled === true;
    const rules = this.rulesAt;
    if (this.cache?.today !== today || this.cache.index !== index || this.cache.owed !== owed || this.cache.rules !== rules) {
      const open = this.group(owed);
      this.cache = { today, index, owed, rules, open };
      // a failed read isn't kept: the next ask tries again
      open.catch(() => {
        if (this.cache?.open === open) this.cache = null;
      });
    }
    return this.cache.open;
  }

  private async group(owed: boolean): Promise<PersonOpen[]> {
    const index = this.b.autocomplete.peopleIndex();
    const mine = await this.mine();
    const items = await this.b.today.openItems();
    const owedRows = owed ? await this.owedToYou() : [];
    const addresses = [...items.flatMap((i) => [i.why.personEmail, i.from?.email, i.thread.fromEmail]), ...owedRows.map((r) => r.row.personEmail)].filter((e): e is string => !!e?.trim());
    const person = await this.isPerson(addresses);
    const people = new Map<string, PersonOpen>();
    const give = (email: string | null | undefined, name: string | null | undefined, item: PersonItem) => {
      const address = email?.trim();
      if (!address) return;
      const key = personKey(address);
      if (mine.has(key) || !person(address)) return;
      let p = people.get(key);
      if (!p) people.set(key, (p = { key, email: address, name: "", items: [], since: null }));
      if (!p.name && name?.trim()) p.name = name.trim();
      p.items.push(item);
    };
    // What matters' order is the order of urgency (Missed, today, waiting on you, the days ahead, Coming up); a row that
    // carries the reply's other promises (`also`) is one act, so it's given whole to its own person
    for (const item of items) {
      const who = personOf(item, person.written);
      if (who) give(who.email, who.name, { kind: "today", item });
    }
    for (const r of owedRows) give(r.row.personEmail, r.row.personName, { kind: "awaiting", row: r.row, thread: r.thread });
    // each one's items, and Open, in People's order: who's waited longest first, what's put off last
    const now = this.b.now();
    for (const p of people.values()) {
      p.name = index?.person(p.email)?.name || p.name || p.email;
      p.items = sortPersonItems(p.items, now);
      p.since = personSince(p.items, now);
    }
    return sortPeopleOpen([...people.values()], now);
  }

  /**
   * The replies owed to you: follow-ups waiting on them, oldest wait first, by the follow-ups' own account
   * rule, their conversations as stored now (never in Trash or Spam). Read only: nothing is closed, made due or said.
   */
  private async owedToYou(): Promise<{ row: FollowupRow; thread: ThreadSummary }[]> {
    const { b } = this;
    const waits = (await b.store.followups.active()).filter((r) => r.kind === "awaiting" && r.personEmail);
    if (!waits.length) return [];
    const threads = new Map((await b.store.threads.summaries([...new Set(waits.map((r) => r.threadId))])).map((t) => [t.id, t]));
    const wanted = new Map<number, boolean>();
    const out: { row: FollowupRow; thread: ThreadSummary }[] = [];
    for (const row of waits) {
      const thread = threads.get(row.threadId);
      if (!thread || thread.inSpam || thread.inTrash) continue;
      if (!wanted.has(thread.accountId)) wanted.set(thread.accountId, await b.followupsWanted(thread.accountId));
      if (wanted.get(thread.accountId)) out.push({ row, thread });
    }
    return out.sort((x, y) => x.row.sentAt - y.row.sentAt || x.row.id - y.row.id);
  }
}

const HOUR = 3_600_000;
/** Everyone's versions kept, one per filter asked lately */
const EVERYONE_FILTERS = 8;

/** Plan 287: People's filter as the service applies it (`PeopleService.scope`). */
interface Scope {
  accounts: number[] | null;
  since: number;
  /** a custom range's end (0: none) */
  until: number;
  key: string;
  index: { accounts?: readonly number[]; since?: number; until?: number };
}

/** Open now: not put off with Later, nor behind What matters' Coming up. */
const openNow = (i: PersonItem, now: number): boolean => personItemAhead(i, now) === null;

/**
 * Whom a What matters item is between you and: a promise's person (whom you promised), a waiting conversation's sender
 * (who's waiting on your answer), a dated item's sender when it's a person's request or someone you've written to (a bill
 * from a utility is What matters' alone); a reminder is nobody's.
 */
export function personOf(item: TodayItem, writtenTo: (email: string) => boolean): { email: string; name: string } | null {
  const { why, thread } = item;
  if (why.kind === "promise") return why.personEmail ? { email: why.personEmail, name: why.personName ?? "" } : null;
  if (why.kind === "waiting") return thread.fromEmail ? { email: thread.fromEmail, name: thread.fromName } : null;
  if (why.kind === "dated") {
    const from = item.from ?? (thread.fromEmail ? { email: thread.fromEmail, name: thread.fromName } : null);
    if (!from) return null;
    return isPersonRequest(why.item?.kind) || writtenTo(from.email) ? from : null;
  }
  return null;
}
