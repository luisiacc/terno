/**
 * Plan 169: the sidebar's order is shown at once and kept while it's on its way (answers and events alike); a
 * failure goes back to the last order the backend holds and says so; a reorder never clears a selection.
 */
import type { Account, Category } from "@terno/core";
import { beforeEach, expect, it, vi } from "vitest";

const { call, error } = vi.hoisted(() => ({ call: vi.fn(), error: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
vi.mock("./snack", () => ({ snack: Object.assign(vi.fn(), { error }) }));
const { reorderAccounts, reorderCategories, withPendingOrder } = await import("./reorder");
const { getApp, setApp, setAccounts, setCategories } = await import("~/state/app");

const cat = (id: number, extra: Partial<Category> = {}) => ({ id, name: `c${id}`, showInInbox: true, ...extra }) as Category;
const acct = (id: number, extra: Partial<Account> = {}) => ({ id, displayName: `a${id}`, ...extra }) as Account;
const ids = (list: readonly { id: number }[]) => list.map((x) => x.id);
/** a promise per call, answered by hand */
function held() {
  const answers: { ok: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  call.mockImplementation(() => new Promise((ok, fail) => answers.push({ ok, fail })));
  return answers;
}

beforeEach(() => {
  call.mockReset();
  error.mockReset();
  setApp({ categories: [1, 2, 3].map((id) => cat(id)), accounts: [1, 2, 3].map((id) => acct(id)), scope: null, checked: new Set() });
});

it("shows the new order before the backend answers, then the backend's", async () => {
  const answers = held();
  const done = reorderCategories([3, 1, 2]);
  expect(ids(getApp().categories)).toEqual([3, 1, 2]);
  expect(call).toHaveBeenCalledWith("categories.reorder", { ids: [3, 1, 2] });
  answers[0]!.ok([3, 1, 2].map((id) => cat(id)));
  await done;
  expect(ids(getApp().categories)).toEqual([3, 1, 2]);
});

it("an older request's answer, or its broadcast, never puts its order back over a newer one on its way", async () => {
  const answers = held();
  const first = reorderAccounts([2, 1, 3]);
  const second = reorderAccounts([2, 3, 1]);
  // the first one's broadcast lands (as boot's handler takes it), then its answer
  setAccounts(withPendingOrder("accounts", [2, 1, 3].map((id) => acct(id))));
  expect(ids(getApp().accounts)).toEqual([2, 3, 1]);
  answers[0]!.ok([2, 1, 3].map((id) => acct(id)));
  await first;
  expect(ids(getApp().accounts)).toEqual([2, 3, 1]);
  answers[1]!.ok([2, 3, 1].map((id) => acct(id)));
  await second;
  expect(ids(getApp().accounts)).toEqual([2, 3, 1]);
});

it("a failure goes back to the order the backend holds (a newer one that failed too never stays) and says so", async () => {
  const answers = held();
  const first = reorderAccounts([3, 2, 1]);
  const second = reorderAccounts([2, 3, 1]);
  answers[0]!.fail(new Error("offline"));
  await first;
  answers[1]!.fail(new Error("offline"));
  await second;
  expect(ids(getApp().accounts)).toEqual([1, 2, 3]);
  expect(error).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith("Couldn’t save the new order, so it’s back as it was. Try again.");
});

it("orders the accounts shown, never older copies of them (a rename on its way, a sync state that changed)", async () => {
  const answers = held();
  const done = reorderAccounts([3, 1, 2]);
  setAccounts(getApp().accounts.map((a) => (a.id === 1 ? acct(1, { displayName: "Renamed" }) : a)));
  answers[0]!.ok([3, 1, 2].map((id) => acct(id)));
  await done;
  expect(getApp().accounts.map((a) => a.displayName)).toEqual(["a3", "Renamed", "a2"]);
});

it("the same order, or one that isn't the list's anymore, saves nothing", async () => {
  await reorderCategories([1, 2, 3]);
  await reorderCategories([2, 1]);
  await reorderCategories([2, 1, 9]);
  expect(call).not.toHaveBeenCalled();
});

it("a reorder keeps a “select all” of the Inbox (which categories are hidden, which accounts keep tabs apart, didn't change)", () => {
  const scope = { kind: "all" } as unknown as ReturnType<typeof getApp>["scope"];
  setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, folder: null, gmailTab: null, query: "", categories: [cat(1, { showInInbox: false }), cat(2, { showInInbox: false }), cat(3)], scope, checked: new Set([7]) });
  setCategories([cat(2, { showInInbox: false }), cat(1, { showInInbox: false }), cat(3)]);
  expect(getApp().scope).toBe(scope);
  const gmail = (id: number) => acct(id, { kind: "gmail", separateTabs: true } as Partial<Account>);
  setApp({ accounts: [gmail(1), gmail(2)] });
  setAccounts([gmail(2), gmail(1)]);
  expect(getApp().scope).toBe(scope);
  expect(getApp().checked.size).toBe(1);
});
