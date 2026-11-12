// @vitest-environment jsdom
/**
 * Plan 159: Review's totals and its way in and out: entered on the category with the most, switched in place, left for
 * where it was entered from (Esc, its category deleted), kept when its last suggestion is answered. With the RPC client mocked.
 */
import type { Category } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}) } }));

const { enterReview, leaveReview, mostWaiting, nextToSort, reviewArrival, reviewFrom, reviewTotals, switchReview, takeReviewArrival } = await import("./review");
const { getApp, navigate, setApp, EMPTY_COUNTS } = await import("~/state/app");
const { useList } = await import("~/state/list");

const cat = (id: number, name: string): Category => ({ id, name, color: "cyan", showInInbox: true }) as unknown as Category;
const CATS = [cat(1, "Facturas"), cat(2, "Clientes"), cat(3, "Lecturas")];
const suggest = (s: Record<number, number>) => setApp({ counts: { ...EMPTY_COUNTS, categorySuggestions: s } });
const tick = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  reviewFrom.origin = null;
  setApp({ categories: CATS });
  suggest({ 1: 4, 2: 14, 3: 31 });
  navigate({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null });
});

describe("reviewTotals", () => {
  it("sums every category's suggestions and lists those with any, in the sidebar's order (plan 200)", () => {
    const { total, pending } = reviewTotals(CATS, { 1: 4, 2: 0, 3: 31 });
    expect(total).toBe(35);
    expect(pending.map((p) => [p.category.name, p.count])).toEqual([["Facturas", 4], ["Lecturas", 31]]);
    // reordered in the sidebar (ids no longer ascending): its order, as it is now
    expect(reviewTotals([CATS[2]!, CATS[0]!, CATS[1]!], { 1: 4, 2: 14, 3: 31 }).pending.map((p) => p.category.id)).toEqual([3, 1, 2]);
    expect(reviewTotals(CATS, {})).toEqual({ total: 0, pending: [] });
  });

  it("Review starts on the one with the most waiting, the first in the sidebar's order when level; none with nothing", () => {
    expect(mostWaiting(reviewTotals(CATS, { 1: 4, 2: 14, 3: 31 }).pending)?.category.id).toBe(3);
    expect(mostWaiting(reviewTotals([CATS[1]!, CATS[0]!, CATS[2]!], { 1: 9, 2: 9, 3: 1 }).pending)?.category.id).toBe(2);
    expect(mostWaiting([])).toBeNull();
  });

  it("an emptied Review goes on to the most waiting of the others, though its own count hasn't caught up yet", () => {
    expect(nextToSort(CATS, { 1: 4, 2: 14, 3: 31 }, 3)?.id).toBe(2);
    expect(nextToSort(CATS, { 3: 31 }, 3)).toBeNull();
  });
});

describe("Review's way in and out", () => {
  it("Esc (leaveReview) goes back to the mailbox it was entered from, not to the category", () => {
    navigate({ view: "sent", accountId: null });
    enterReview(3);
    expect(getApp().reviewCategoryId).toBe(3);
    leaveReview();
    expect(getApp()).toMatchObject({ view: "sent", reviewCategoryId: null, categoryId: null });
  });

  it("switching categories keeps the way back", () => {
    navigate({ categoryId: 1, accountId: null });
    enterReview(3);
    switchReview(2);
    expect(getApp().reviewCategoryId).toBe(2);
    // a category's own Review from its menu while in Review is a switch too
    enterReview(1);
    expect(getApp().reviewCategoryId).toBe(1);
    leaveReview();
    expect(getApp()).toMatchObject({ view: "all", categoryId: 1, reviewCategoryId: null });
  });

  it("entered from a search, it comes back to the search, on the rows it showed and the result that was open (Codex code review #2)", async () => {
    setApp({ query: "pago" });
    const { listKey } = await import("~/state/list");
    const items = [41, 42, 43].map((id) => ({ id }) as never);
    useList.setState({ key: listKey(), itemsKey: listKey(), items, index: new Map([[41, 0], [42, 1], [43, 2]]), nextCursor: { lastDate: 2, id: 2 }, loading: false });
    setApp({ selectedId: 43 });
    enterReview(3);
    expect(getApp().query).toBe("");
    // Review's own rows meanwhile
    useList.setState({ key: "review", itemsKey: "review", items: [], index: new Map(), nextCursor: null });
    leaveReview();
    expect(getApp()).toMatchObject({ query: "pago", reviewCategoryId: null, selectedId: 43 });
    expect(useList.getState()).toMatchObject({ itemsKey: listKey(), nextCursor: { lastDate: 2, id: 2 } });
    expect(useList.getState().items.map((t) => t.id)).toEqual([41, 42, 43]);
  });

  it("a sentence's preview opened from Review and cancelled keeps the way back (Codex code review round 2 #1)", () => {
    navigate({ view: "sent", accountId: null });
    enterReview(3);
    // enterPreview's and leavePreview's own writes (state/action-preview)
    setApp({ actionPreview: "p1", view: "all", reviewCategoryId: null, query: "" });
    setApp({ actionPreview: null, view: "all", reviewCategoryId: 3 });
    leaveReview();
    expect(getApp()).toMatchObject({ view: "sent", reviewCategoryId: null });
  });

  it("a place gone meanwhile (its category, in another window) isn't gone back to: the Inbox instead (Codex code review #3)", () => {
    navigate({ categoryId: 1, accountId: null });
    enterReview(3);
    setApp({ categories: CATS.filter((c) => c.id !== 1) });
    expect(getApp().reviewCategoryId).toBe(3);
    leaveReview();
    expect(getApp()).toMatchObject({ view: "inbox", categoryId: null, reviewCategoryId: null });
  });

  it("with nowhere remembered, leaves for the Inbox", () => {
    setApp({ reviewCategoryId: 2, view: "all" });
    leaveReview();
    expect(getApp()).toMatchObject({ view: "inbox", reviewCategoryId: null, categoryId: null });
  });

  it("its last suggestion answered, it stays where it is (Undo brings the rows back here), the way back kept", async () => {
    navigate({ view: "archive", accountId: null });
    enterReview(1);
    suggest({ 1: 0, 2: 14, 3: 31 });
    await tick();
    expect(getApp().reviewCategoryId).toBe(1);
    leaveReview();
    expect(getApp()).toMatchObject({ view: "archive", reviewCategoryId: null });
  });

  it("its category deleted: out, to where it was entered from", () => {
    navigate({ view: "sent", accountId: null });
    enterReview(3);
    setApp({ categories: CATS.filter((c) => c.id !== 3) });
    expect(getApp()).toMatchObject({ view: "sent", reviewCategoryId: null });
  });

  it("left for another mailbox, the way back is forgotten; a search typed in it keeps it", () => {
    navigate({ view: "sent", accountId: null });
    enterReview(3);
    // a search typed in Review leaves it, and its Esc comes back to it
    setApp({ query: "x" });
    expect(reviewFrom.origin).not.toBeNull();
    setApp({ query: "", reviewCategoryId: 3 });
    navigate({ view: "archive", accountId: null });
    expect(reviewFrom.origin).toBeNull();
  });
});

describe("plan 197: the arrival a switch owes", () => {
  it("is spent once, by the category switched to; with no rows it's spent and plays nothing", () => {
    setApp({ categories: CATS });
    suggest({ 1: 2, 2: 1 });
    enterReview(1);
    switchReview(2);
    expect(takeReviewArrival(1, 3)).toBe(false);
    expect(takeReviewArrival(2, 3)).toBe(true);
    expect(takeReviewArrival(2, 3)).toBe(false);
    switchReview(1);
    expect(takeReviewArrival(1, 0)).toBe(false);
    expect(reviewArrival.categoryId).toBeNull();
    leaveReview();
  });

  it("is dropped when Review goes anywhere else before the rows come: a later entry doesn't play it", () => {
    setApp({ categories: CATS });
    suggest({ 1: 2, 2: 1 });
    enterReview(1);
    switchReview(2);
    leaveReview();
    expect(reviewArrival.categoryId).toBeNull();
    enterReview(2);
    expect(takeReviewArrival(2, 3)).toBe(false);
    leaveReview();
  });
});
