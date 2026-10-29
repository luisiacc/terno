/**
 * What the triage snacks say: one sentence per count (plural rules of the
 * active language), with the undo's accessible name in the same language.
 * Node, with the RPC client mocked and a minimal fake <html>.
 */
import type { ThreadSummary } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({}),
    on: () => () => {},
  },
}));

const { act, said } = await import("./actions");
const { setApp } = await import("~/state/app");
const { useList } = await import("~/state/list");
const { resetSnacks, useSnack } = await import("~/lib/snack");

const row = (id: number): ThreadSummary => ({ id, unread: false, starred: false, categoryIds: [] }) as unknown as ThreadSummary;

beforeEach(() => {
  fake.handlers = {};
  resetSnacks();
  const items = [row(1), row(2), row(3)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  setApp({ view: "inbox", query: "", selectedId: null, checked: new Set(), scope: null });
});
afterEach(() => setLocale("en", en));

describe("action snacks", () => {
  it("one conversation says what happened; several add the count", () => {
    expect(said("archive", 1)).toBe("Archived");
    expect(said("archive", 3)).toBe("Archived · 3 conversations");
    expect(said("notSpam", 1234)).toBe("Moved to Inbox · 1,234 conversations");
    setLocale("es", es);
    expect(said("archive", 1)).toBe("Archivado");
    expect(said("trash", 2)).toBe("Movido a la papelera · 2 conversaciones");
  });

  it("the snack and its undo's accessible name follow the language", async () => {
    setLocale("es", es);
    fake.handlers["threads.act"] = async () => ({ undoId: 9 });
    await act("archive", [1, 2]);
    const s = useSnack.getState().current;
    expect(s?.message).toBe("Archivado · 2 conversaciones");
    expect(s?.action?.label).toBe("Deshacer");
    expect(s?.action?.name).toBe("Deshacer archivar");
  });

  it("a failure says it couldn't complete, with the reason", async () => {
    fake.handlers["threads.act"] = async () => {
      throw new Error("offline");
    };
    await act("archive", [1]);
    expect(useSnack.getState().current?.message).toBe("Couldn’t complete: offline");
  });
});

describe("a search's selection spanning places (plan 64)", () => {
  const placed = (id: number, inInbox: boolean, inSpam = false, inTrash = false) => ({ ...row(id), inInbox, inSpam, inTrash }) as ThreadSummary;
  const sent: { action: string; threadIds: number[] }[] = [];
  beforeEach(() => {
    sent.length = 0;
    fake.handlers["threads.act"] = async (p) => {
      sent.push(p as { action: string; threadIds: number[] });
      return { undoId: 1 };
    };
    const items = [placed(1, true), placed(2, false, false, true), placed(3, false, true), placed(4, true)];
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  });

  it("a key on the selection acts on the rows it fits, as the buttons do (! never spams the trashed one)", async () => {
    setApp({ query: "factura", checked: new Set([1, 2]) });
    await act("spam");
    // acting clears the selection: the same two again
    setApp({ checked: new Set([1, 2]) });
    await act("moveToInbox");
    expect(sent).toEqual([
      { action: "spam", threadIds: [1] },
      { action: "moveToInbox", threadIds: [2] },
    ]);
  });

  it("it reads the selection when it runs: a same-size selection made since is the one acted on", async () => {
    setApp({ query: "factura", checked: new Set([1, 2]) });
    setApp({ checked: new Set([3, 4]) });
    await act("trash");
    expect(sent).toEqual([{ action: "trash", threadIds: [3, 4] }]);
  });

  it("outside a search, the view's rule: every selected row", async () => {
    setApp({ query: "", checked: new Set([1, 2]) });
    await act("spam");
    expect(sent).toEqual([{ action: "spam", threadIds: [1, 2] }]);
  });
});
