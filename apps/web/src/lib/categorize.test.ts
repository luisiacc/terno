/**
 * addToCategory's optimistic unread count: kept when the add succeeds,
 * reverted and re-read from the backend when it fails. Node, with the RPC
 * client mocked and a minimal fake <html>.
 */
import type { ThreadSummary } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, calls: [] as string[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      fake.calls.push(method);
      const h = fake.handlers[method];
      return h ? h(params) : Promise.resolve({});
    },
  },
}));

const { addToCategory, removeSenderFromCategory } = await import("./categorize");
const { getApp, setApp, EMPTY_COUNTS } = await import("~/state/app");
const { useList } = await import("~/state/list");
const { registerUndo, undoLast, undoNow, useSnack } = await import("~/lib/snack");

const CAT = 7;
const row = (id: number, unread: boolean): ThreadSummary => ({ id, unread, categoryIds: [] }) as unknown as ThreadSummary;

beforeEach(() => {
  fake.calls.length = 0;
  fake.handlers = {};
  const items = [row(1, true), row(2, true), row(3, false)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  setApp({ counts: { ...EMPTY_COUNTS, categoryUnread: { [CAT]: 4 } } });
});

describe("addToCategory: unread counts", () => {
  it("bumps the category's unread count in the same frame", async () => {
    fake.handlers["categories.addThreads"] = async () => ({ added: 2, addedIds: [1, 2], batchId: 1 });
    const done = addToCategory(CAT, [1, 2, 3]);
    expect(getApp().counts.categoryUnread[CAT]).toBe(6);
    await done;
    expect(getApp().counts.categoryUnread[CAT]).toBe(6);
  });

  it("a rejected add takes the bump back and re-reads the real counts", async () => {
    let release!: () => void;
    const countsAsked = new Promise<void>((r) => (release = r));
    fake.handlers["categories.addThreads"] = async () => {
      throw new Error("refused");
    };
    fake.handlers["counts.get"] = async () => {
      release();
      return { ...EMPTY_COUNTS, categoryUnread: { [CAT]: 4 } };
    };
    await addToCategory(CAT, [1, 2]);
    // reverted at once, before the backend answers
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
    await countsAsked;
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls).toContain("counts.get");
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
  });

  it("if the counts can't be re-read either, the reverted value stands", async () => {
    fake.handlers["categories.addThreads"] = async () => {
      throw new Error("refused");
    };
    fake.handlers["counts.get"] = async () => {
      throw new Error("offline");
    };
    await addToCategory(CAT, [1]);
    await new Promise((r) => setTimeout(r, 0));
    expect(getApp().counts.categoryUnread[CAT]).toBe(4);
  });

  it("a rejected add says so in the active language, with the reason", async () => {
    fake.handlers["categories.addThreads"] = async () => {
      throw new Error("refused");
    };
    await addToCategory(CAT, [1]);
    expect(useSnack.getState().current?.message).toBe("Couldn’t add: refused");
    setLocale("es", es);
    try {
      await addToCategory(CAT, [2]);
      expect(useSnack.getState().current?.message).toBe("No se pudo añadir: refused");
    } finally {
      setLocale("en", en);
    }
  });
});

describe("removeSenderFromCategory (plan 77): undo", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const undoCalls = () => fake.calls.filter((m) => m === "categorize.undo").length;
  const answer = () => {
    let release!: (v: unknown) => void;
    fake.handlers["categories.removeSender"] = () => new Promise((r) => (release = r));
    return (v: unknown) => release(v);
  };
  beforeEach(() => {
    setApp({ categories: [{ id: CAT, name: "Facturas" }] as never });
    const items = [1, 2, 3].map((id) => ({ ...row(id, false), fromEmail: id < 3 ? "recibos@rappi.com" : "x@y.com", categoryIds: [CAT] }));
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
    fake.handlers["categorize.undo"] = async () => ({ removed: 0, restored: 2 });
    fake.handlers["threads.list"] = async () => ({ items: [], nextCursor: null });
  });

  it("z right after the click undoes the removal once the backend names its batch", async () => {
    const release = answer();
    const done = removeSenderFromCategory(CAT, "recibos@rappi.com");
    undoLast();
    await settle();
    expect(undoCalls()).toBe(0);
    release({ batchId: 5, removed: [1, 2] });
    await done;
    await settle();
    expect(undoCalls()).toBe(1);
    // nothing left to offer: the progress snack went, no Undo button stayed
    expect(useSnack.getState().current?.action).toBeUndefined();
  });

  it("an action taken while it runs keeps z: the later answer doesn't take it over", async () => {
    const release = answer();
    const done = removeSenderFromCategory(CAT, "recibos@rappi.com");
    const later = vi.fn();
    registerUndo(later);
    release({ batchId: 5, removed: [1, 2] });
    await done;
    undoLast();
    await settle();
    expect(later).toHaveBeenCalledTimes(1);
    expect(undoCalls()).toBe(0);
  });

  it("a failure partway still offers Undo for what was done", async () => {
    fake.handlers["categories.removeSender"] = async () => {
      throw Object.assign(new Error("boom"), { details: { batchId: 9 } });
    };
    await removeSenderFromCategory(CAT, "recibos@rappi.com");
    const snack = useSnack.getState().current!;
    expect(snack.message).toBe("Couldn’t remove: boom");
    undoNow(snack.action!.undo!);
    await settle();
    expect(undoCalls()).toBe(1);
  });
});
