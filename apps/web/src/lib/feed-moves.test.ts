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
const { clearMoves, moveNextRows } = await import("~/state/list");
const { useToday } = await import("~/state/today");

type Row = ReturnType<typeof useToday.getState>["rows"][number];
const row = (id: string, threadId: number, more: Partial<Row> = {}) => ({ id, threadId, group: "today", ...more }) as Row;
const feed = () => document.querySelector("[data-feed-rows]")!;
let stop = () => {};

function drawn(rows: Row[]) {
  useToday.setState({ rows });
  document.body.innerHTML = `<div data-feed-rows></div>`;
  stop = installFeedMoves((s) => s.rows.map((r) => ({ key: r.id })));
}

afterEach(() => {
  stop();
  clearMoves();
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

it("an Undo of a Done: its row comes back from Earlier (the same row, another part): it moves, and a slot drawn anew for it arrives", () => {
  drawn([row("b", 2), row("h", 9), row("a", 1, { line: {} as never })]);
  moveNextRows([1]);
  useToday.setState({ rows: [row("a", 1), row("b", 2), row("h", 9)] });
  expect(feed().hasAttribute("data-reflow")).toBe(true);
  expect(slotComes("a")).toBe(true);
  expect(slotGoes("a")).toBe(false);
});

it("Codex code review #4: an Undo's row only pushed along by another arriving isn't brought back", () => {
  drawn([row("b", 2), row("a", 1, { line: {} as never })]);
  moveNextRows([1]);
  useToday.setState({ rows: [row("x", 7), row("b", 2), row("a", 1, { line: {} as never })] });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
});

it("Codex code review #7: a heading keyed anew by its group's next row neither leaves nor arrives", () => {
  useToday.setState({ rows: [row("a", 1), row("b", 2)] });
  document.body.innerHTML = `<div data-feed-rows></div>`;
  stop = installFeedMoves((s) => [{ key: `h-today-${s.rows[0]!.id}`, same: "h-today" }, ...s.rows.map((r) => ({ key: r.id }))]);
  movingFeed(() => useToday.setState({ rows: [row("b", 2)] }));
  expect(slotGoes("a")).toBe(true);
  expect(slotGoes("h-today-a")).toBe(false);
  expect(slotComes("h-today-b")).toBe(false);
});

it("Codex code review #5: Coming up's motion is for its own rows, and doesn't take an Undo's place", () => {
  drawn([row("a", 1), row("e", 5, { line: {} as never })]);
  moveNextRows([3]);
  moveNextRows(null, { ahead: true });
  // a page of Earlier first: not Coming up's
  useToday.setState({ rows: [row("a", 1), row("e", 5, { line: {} as never }), row("f", 6, { line: {} as never })] });
  expect(feed().hasAttribute("data-reflow")).toBe(false);
  // Coming up's rows
  useToday.setState({ rows: [row("a", 1), row("u", 8, { ahead: true }), row("e", 5, { line: {} as never }), row("f", 6, { line: {} as never })] });
  expect(feed().hasAttribute("data-reflow")).toBe(true);
  expect(slotComes("u")).toBe(true);
  // and the Undo's is still owed
  document.body.innerHTML = `<div data-feed-rows></div>`;
  useToday.setState({ rows: [row("c", 3), row("a", 1), row("u", 8, { ahead: true }), row("e", 5, { line: {} as never }), row("f", 6, { line: {} as never })] });
  expect(feed().hasAttribute("data-reflow")).toBe(true);
  expect(slotComes("c")).toBe(true);
});
