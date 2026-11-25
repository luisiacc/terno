// @vitest-environment jsdom
/**
 * Plan 271: What matters' feed moves for a change an act made, or one motion is owed to, naming the slots that come and
 * go by their drawn keys; any other change (an answer refreshing the feed, a scroll) moves nothing.
 */
import { afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, onAttach: () => () => {} } }));

const { installFeedMoves, movingFeed, slotComes, slotGoes } = await import("./feed-moves");
const { moveNextRows, movesPaid } = await import("~/state/list");
const { useToday } = await import("~/state/today");

type Row = ReturnType<typeof useToday.getState>["rows"][number];
const row = (id: string, threadId: number) => ({ id, threadId }) as Row;
const feed = () => document.querySelector("[data-feed-rows]")!;
let stop = () => {};

function drawn(rows: Row[]) {
  useToday.setState({ rows });
  document.body.innerHTML = `<div data-feed-rows></div>`;
  stop = installFeedMoves((s) => s.rows.map((r) => r.id));
}

afterEach(() => {
  stop();
  movesPaid();
  document.body.innerHTML = "";
});

it("an act's change: what it takes away goes, the rest slide", () => {
  drawn([row("a", 1), row("b", 2), row("c", 3)]);
  movingFeed(() => useToday.setState({ rows: [row("a", 1), row("c", 3)] }));
  expect(feed().hasAttribute("data-reflow")).toBe(true);
  expect(slotGoes("b")).toBe(true);
  expect(slotGoes("a")).toBe(false);
});

it("an answer refreshing the feed, unasked: nothing moves", () => {
  drawn([row("a", 1), row("b", 2)]);
  useToday.setState({ rows: [row("a", 1)] });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
});

it("an Undo's motion: only the answer bringing its conversation's row back moves, once", () => {
  drawn([row("a", 1), row("c", 3)]);
  moveNextRows([2]);
  // the backend's own news of something else first: not this one's
  useToday.setState({ rows: [row("a", 1), row("c", 3), row("d", 4)] });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
  useToday.setState({ rows: [row("a", 1), row("b", 2), row("c", 3), row("d", 4)] });
  expect(feed().hasAttribute("data-reflow")).toBe(true);
  expect(slotComes("b")).toBe(true);
  // (one only pushed down slides: it's drawn already, and arrives only if drawn anew)
  expect(slotGoes("d")).toBe(false);
  // paid: the next change is the feed's own again
  document.body.innerHTML = `<div data-feed-rows></div>`;
  useToday.setState({ rows: [row("a", 1)] });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
});

it("a change bigger than a moment just appears", () => {
  drawn([]);
  moveNextRows();
  useToday.setState({ rows: Array.from({ length: 60 }, (_, i) => row(`r${i}`, i)) });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
});

it("an Undo of a Done: its row comes back from Earlier (the same row, moved), and that moves", () => {
  drawn([row("b", 2), row("h", 9), row("a", 1)]);
  moveNextRows([1]);
  useToday.setState({ rows: [row("a", 1), row("b", 2), row("h", 9)] });
  expect(feed().hasAttribute("data-reflow")).toBe(true);
});

it("a slot drawn anew for a row that only moved arrives too (it wasn't drawn where it was)", () => {
  drawn([row("b", 2), row("h", 9), row("a", 1)]);
  moveNextRows([1]);
  useToday.setState({ rows: [row("a", 1), row("b", 2), row("h", 9)] });
  expect(slotComes("a")).toBe(true);
  expect(slotGoes("a")).toBe(false);
});
