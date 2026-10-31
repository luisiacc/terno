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

const { addToCategory, answerReview, fileAlways, filterNameOf, removeSenderFromCategory } = await import("./categorize");
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

describe("plan 80: answering from the Review list", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const ids = () => useList.getState().items.map((t) => t.id);
  beforeEach(() => {
    setApp({ categories: [{ id: CAT, name: "Facturas" }] as never, reviewCategoryId: CAT, selectedId: 1, counts: { ...EMPTY_COUNTS, categoryUnread: { [CAT]: 4 }, categorySuggestions: { [CAT]: 3 } } });
    fake.handlers["categorize.suggestions"] = async () => ({ items: [] });
  });

  it("✓ files it as an accepted suggestion; the row leaves at once, the selection moves on, both counts move", async () => {
    let release!: (v: unknown) => void;
    fake.handlers["categories.addThreads"] = () => new Promise((r) => (release = r));
    const done = answerReview(1, CAT, true);
    expect(ids()).toEqual([2, 3]);
    expect(getApp().selectedId).toBe(2);
    expect(getApp().counts.categorySuggestions[CAT]).toBe(2);
    // the unread row joined the category's unread count, read before it left
    expect(getApp().counts.categoryUnread[CAT]).toBe(5);
    release({ added: 1, addedIds: [1], batchId: 4 });
    await done;
    expect(fake.calls).not.toContain("counts.get");
  });

  it("a failed answer brings the real counts and the list back", async () => {
    fake.handlers["categorize.feedback"] = async () => {
      throw new Error("refused");
    };
    fake.handlers["counts.get"] = async () => ({ ...EMPTY_COUNTS, categorySuggestions: { [CAT]: 3 } });
    await answerReview(2, CAT, false);
    await settle();
    expect(fake.calls).toEqual(expect.arrayContaining(["categorize.feedback", "counts.get", "categorize.suggestions"]));
    expect(getApp().counts.categorySuggestions[CAT]).toBe(3);
    expect(useSnack.getState().current?.message).toBe("Couldn’t save: refused");
  });
});

describe("plan 80: always add — one undo for the filter and the batch", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const scope = { kind: "subject", email: "uber.receipts@uber.com", subject: "Tu recibo" } as const;
  beforeEach(() => {
    setApp({ categories: [{ id: CAT, name: "Facturas" }] as never, reviewCategoryId: CAT, selectedId: 1 });
    fake.handlers["categorize.suggestions"] = async () => ({ items: [] });
  });

  it("files now, says future mail too; Undo takes back the filter first, then the batch", async () => {
    fake.handlers["categorize.apply"] = async (p) => {
      expect(p).toEqual({ categoryId: CAT, scope, always: true, filterName: "Uber · Tu recibo → Facturas" });
      return { added: 3, batchId: 8, filter: { id: 2, filterUndo: 5 }, filterFailed: false };
    };
    const order: string[] = [];
    fake.handlers["similar.undo"] = async (p) => (order.push(`filter ${(p as { filterUndo: number }).filterUndo}`), { restored: 0 });
    fake.handlers["categorize.undo"] = async (p) => (order.push(`batch ${(p as { batchId: number }).batchId}`), { removed: 3 });
    await fileAlways(CAT, scope, 1, "Uber · Tu recibo → Facturas");
    expect(useList.getState().items.map((t) => t.id)).not.toContain(1);
    const snack = useSnack.getState().current!;
    expect(snack.message).toBe("3 added to Facturas, future mail too");
    undoNow(snack.action!.undo!);
    await settle();
    expect(order).toEqual(["filter 5", "batch 8"]);
  });

  it("the filter's undo failing still undoes the batch; the retry redoes only the filter", async () => {
    fake.handlers["categorize.apply"] = async () => ({ added: 2, batchId: 8, filter: { id: 2, filterUndo: 5 }, filterFailed: false });
    let filterFails = true;
    const order: string[] = [];
    fake.handlers["similar.undo"] = async () => {
      order.push("filter");
      if (filterFails) throw new Error("disk full");
      return { restored: 0 };
    };
    fake.handlers["categorize.undo"] = async () => (order.push("batch"), { removed: 2 });
    await fileAlways(CAT, scope, 1, "x");
    const undo = useSnack.getState().current!.action!.undo!;
    undoNow(undo);
    await settle();
    expect(order).toEqual(["filter", "batch"]);
    expect(undo.state).toBe("ready");
    filterFails = false;
    undoNow(undo);
    await settle();
    expect(order).toEqual(["filter", "batch", "filter"]);
    expect(undo.state).toBe("done");
  });

  it("the filter failing keeps the mail filed and says so; a failure partway still offers Undo for its batch", async () => {
    fake.handlers["categorize.apply"] = async () => ({ added: 2, batchId: 8, filter: null, filterFailed: true });
    await fileAlways(CAT, scope, 1, "x");
    expect(useSnack.getState().current).toMatchObject({ message: "2 added to Facturas", description: "Couldn’t set up the filter for future mail. You can add it in Settings → Filters." });
    fake.handlers["categorize.apply"] = async () => {
      throw Object.assign(new Error("boom"), { details: { batchId: 9 } });
    };
    fake.handlers["categorize.undo"] = async () => ({ removed: 1 });
    await fileAlways(CAT, scope, 2, "x");
    const snack = useSnack.getState().current!;
    expect(snack.message).toBe("Couldn’t add: boom");
    undoNow(snack.action!.undo!);
    await settle();
    expect(fake.calls.filter((m) => m === "categorize.undo")).toHaveLength(1);
    expect(fake.calls).not.toContain("similar.undo");
  });
});

describe("plan 80: the filter's name", () => {
  it("fits the filter name cap: a long subject shortens, the category stays at the end", () => {
    const scope = { kind: "subject", email: "a@b.com", subject: "x".repeat(400) } as const;
    const name = filterNameOf(scope, "Rappi", "Facturas");
    expect([...name].length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/^Rappi · x+… → Facturas$/);
    expect(filterNameOf({ kind: "sender", email: "a@b.com" }, null, "Facturas")).toBe("a@b.com → Facturas");
    // plan 81: the snackbar's domain and list lines name their filter by what they match, not the sender
    expect(filterNameOf({ kind: "domain", domain: "acme.studio" }, "Javier Ortiz", "Clientes")).toBe("@acme.studio → Clientes");
    expect(filterNameOf({ kind: "list", listId: "boletin.xataka.com" }, "Xataka", "Lecturas")).toBe("boletin.xataka.com → Lecturas");
    expect([...filterNameOf({ kind: "sender", email: "a@b.com" }, "y".repeat(300), "z".repeat(300))].length).toBeLessThanOrEqual(120);
  });

  it("a failure partway that already made the filter offers the one Undo for both", async () => {
    setApp({ categories: [{ id: CAT, name: "Facturas" }] as never, reviewCategoryId: CAT, selectedId: 1 });
    fake.handlers["categorize.suggestions"] = async () => ({ items: [] });
    fake.handlers["categorize.apply"] = async () => {
      throw Object.assign(new Error("boom"), { details: { batchId: null, filterUndo: 4 } });
    };
    await fileAlways(CAT, { kind: "sender", email: "a@b.com" }, 1, "x");
    const snack = useSnack.getState().current!;
    undoNow(snack.action!.undo!);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls).toContain("similar.undo");
    expect(fake.calls).not.toContain("categorize.undo");
  });
});
