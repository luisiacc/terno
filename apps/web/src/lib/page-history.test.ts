/**
 * Plan 24: the List layout's history, against a fake history with the
 * browser's asynchronous back() (its popstate comes later, when the test
 * says) and fake timers.
 */
import { describe, expect, it } from "vitest";
import { createPageHistory, REPLACE_DEBOUNCE_MS, TRAVERSAL_FALLBACK_MS, entryOf, type Shown } from "./page-history";

function harness(o: { mailbox?: string; hash?: string; state?: unknown } = {}) {
  const entries: { state: unknown; url: string }[] = [{ state: o.state ?? null, url: o.hash ?? "" }];
  let at = 0;
  const calls: string[] = [];
  const timers = new Map<number, { fn: () => void; due: number }>();
  let now = 0;
  let nextTimer = 1;
  const opened: number[] = [];
  let closed = 0;
  /** a back() whose popstate hasn't been delivered yet */
  let pendingPop = false;
  const history = {
    get state() {
      return entries[at]!.state;
    },
    pushState(state: unknown, _u: string, url?: string) {
      calls.push(`push ${url}`);
      entries.splice(at + 1, entries.length, { state, url: url ?? "" });
      at++;
    },
    replaceState(state: unknown, _u: string, url?: string) {
      calls.push(`replace ${url}`);
      entries[at] = { state, url: url ?? "" };
    },
    back() {
      calls.push("back");
      if (at === 0) return;
      at--;
      pendingPop = true;
    },
  };
  const h = createPageHistory({
    history,
    mailbox: o.mailbox ?? "/?mailbox=a",
    hash: () => entries[at]!.url,
    open: (id) => opened.push(id),
    close: () => void closed++,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
      if (t.due > now) continue;
      timers.delete(id);
      t.fn();
    }
  };
  /** the browser delivers the popstate of the back() in flight */
  const deliver = (list = "L") => {
    if (!pendingPop) throw new Error("no popstate pending");
    pendingPop = false;
    h.onPop(entries[at]!.state, list);
  };
  /** the user presses the browser's Back or Forward */
  const browser = (delta: -1 | 1, list = "L") => {
    at += delta;
    h.onPop(entries[at]!.state, list);
  };
  return { h, calls, entries, opened, advance, deliver, browser, get at() { return at; }, get closed() { return closed; } };
}

const list = (l = "L"): Shown => ({ page: "list", id: null, list: l });
const thread = (id: number, l = "L"): Shown => ({ page: "thread", id, list: l });
const compose = (l = "L"): Shown => ({ page: "compose", id: null, list: l });

describe("page history (plan 24)", () => {
  it("opening pushes one entry; closing goes back over it (no second list entry)", () => {
    const t = harness();
    t.h.sync(thread(5));
    expect(t.calls).toEqual(["push #/thread/5"]);
    expect(entryOf(t.entries[1]!.state, "/?mailbox=a")).toMatchObject({ page: "thread", id: 5, list: "L" });
    t.h.sync(list());
    expect(t.calls.at(-1)).toBe("back");
    t.deliver();
    // the popstate of our own back() changes nothing in the app
    expect(t.closed).toBe(0);
    expect(t.opened).toEqual([]);
    expect(t.at).toBe(0);
  });

  it("j and k replace the entry once the moves pause (at most one call per 300 ms)", () => {
    const t = harness();
    t.h.sync(thread(1));
    for (let id = 2; id <= 40; id++) {
      t.h.sync(thread(id));
      t.advance(30);
    }
    expect(t.calls).toEqual(["push #/thread/1"]);
    t.advance(REPLACE_DEBOUNCE_MS);
    expect(t.calls).toEqual(["push #/thread/1", "replace #/thread/40"]);
    expect(t.entries).toHaveLength(2);
  });

  it("closing drops a replace still waiting: it never lands on the list's entry", () => {
    const t = harness();
    t.h.sync(thread(1));
    t.h.sync(thread(2));
    t.h.sync(list());
    t.deliver();
    t.advance(REPLACE_DEBOUNCE_MS * 2);
    expect(t.calls).toEqual(["push #/thread/1", "back"]);
    expect(t.entries[0]!.state).toBeNull();
  });

  it("open → Esc → open before the popstate lands: the push waits for it, then lands above the list", () => {
    const t = harness();
    t.h.sync(thread(1));
    t.h.sync(list());
    t.h.sync(thread(2));
    expect(t.calls).toEqual(["push #/thread/1", "back"]);
    expect(t.h.inspect().traversing).toBe(true);
    t.deliver();
    expect(t.calls).toEqual(["push #/thread/1", "back", "push #/thread/2"]);
    expect(t.entries).toHaveLength(2);
    expect(t.at).toBe(1);
  });

  it("open → close → open → close, all before the first popstate: nothing is pushed once it lands (Codex review)", () => {
    const t = harness();
    t.h.sync(thread(1));
    t.h.sync(list());
    t.h.sync(thread(2));
    t.h.sync(list());
    t.deliver();
    expect(t.calls).toEqual(["push #/thread/1", "back"]);
    expect(t.entries[t.at]!.state).toBeNull();
    expect(t.h.inspect()).toMatchObject({ traversing: false, shown: { page: "list" } });
  });

  it("a back() with nothing to go back to (its popstate never comes) is over after the fallback", () => {
    const t = harness();
    // a reload left only our entry (the base below it lost): the machine believes it's on a page
    t.entries[0] = { state: { terno: 1, page: "thread", id: 3, list: "L", mailbox: "/?mailbox=a" }, url: "#/thread/3" };
    expect(t.h.boot("L")).toBe(3);
    t.h.sync(list());
    expect(t.calls.at(-1)).toBe("back");
    t.h.sync(thread(4));
    t.advance(TRAVERSAL_FALLBACK_MS);
    expect(t.h.inspect().traversing).toBe(false);
    expect(t.calls.at(-1)).toBe("push #/thread/4");
  });

  it("the browser's Back closes, its Forward reopens the same thread over the same list", () => {
    const t = harness();
    t.h.sync(thread(7));
    t.browser(-1);
    expect(t.closed).toBe(1);
    t.browser(1);
    expect(t.opened).toEqual([7]);
    // and what the app then shows (the same thread) writes nothing
    t.h.sync(thread(7));
    expect(t.calls).toEqual(["push #/thread/7"]);
  });

  it("j → Back → Forward within 300 ms: the replace still waiting is dropped (never written over the list), Forward reopens the entry as written", () => {
    const t = harness();
    t.h.sync(thread(1));
    t.h.sync(thread(2));
    t.browser(-1);
    t.browser(1);
    expect(t.opened).toEqual([1]);
  });

  it("a Forward made on another list, or by another mailbox, is dropped: the list stays (R6)", () => {
    const t = harness();
    t.h.sync(thread(7, "inbox"));
    t.browser(-1, "inbox");
    t.browser(1, "category 3");
    expect(t.opened).toEqual([]);
    expect(t.calls.at(-1)).toBe("replace #/");
    expect(entryOf({ terno: 1, page: "thread", id: 7, list: "L", mailbox: "/?mailbox=b" }, "/?mailbox=a")).toBeNull();
  });

  it("a new message replaces a conversation's entry, so leaving it always lands on the list (R1); a Forward to it lands on the list", () => {
    const t = harness();
    t.h.sync(thread(1));
    t.h.sync(compose());
    expect(t.calls).toEqual(["push #/thread/1", "replace #/compose"]);
    t.h.sync(list());
    t.deliver();
    expect(t.at).toBe(0);
    t.browser(1);
    expect(t.opened).toEqual([]);
    expect(t.closed).toBe(1);
    expect(t.calls.at(-1)).toBe("replace #/");
  });

  it("boot: a reload on a conversation of this mailbox reopens it; garbage, another mailbox's or a typed link is the list", () => {
    const own = harness({ state: { terno: 1, page: "thread", id: 12, list: "old", mailbox: "/?mailbox=a" }, hash: "#/thread/12" });
    expect(own.h.boot("L")).toBe(12);
    // the entry is rescoped to the list the app opens with
    expect(own.entries[0]!.state).toMatchObject({ id: 12, list: "L" });
    for (const state of [{ terno: 1, page: "thread", id: -4, list: "L", mailbox: "/?mailbox=a" }, { terno: 1, page: "thread", id: 2 ** 60, list: "L", mailbox: "/?mailbox=a" }, { terno: 1, page: "thread", id: 3, list: "L", mailbox: "/?mailbox=b" }, "#/thread/3", null]) {
      const t = harness({ state, hash: "#/thread/3" });
      expect(t.h.boot("L")).toBeNull();
      expect(t.calls).toEqual(["replace #/"]);
    }
    // a plain address is left as it is
    const plain = harness();
    expect(plain.h.boot("L")).toBeNull();
    expect(plain.calls).toEqual([]);
  });

  it("nothing is written while the app stays on the list (Split never leaves it)", () => {
    const t = harness();
    t.h.sync(list());
    t.h.sync(list("other"));
    t.advance(10_000);
    expect(t.calls).toEqual([]);
  });
});
