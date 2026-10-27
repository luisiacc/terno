import type { MailNotice } from "@terno/core";
import { describe, expect, it } from "vitest";
import { DesktopAttention, MAX_LIVE, OpenRelay, parseBadge, parseNotice, type NotificationLike } from "./attention";

const notice = (o: Partial<MailNotice> = {}): MailNotice => ({ id: "mail-1", count: 1, threadId: 42, senders: ["Ana Pérez"], senderCount: 1, subject: "Presupuesto", snippet: "Te mando…", ...o });

class FakeNotification implements NotificationLike {
  static made: FakeNotification[] = [];
  shown = false;
  closed = false;
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly options: { title: string; subtitle?: string; body: string; silent: boolean }) {
    FakeNotification.made.push(this);
  }
  show() {
    // listeners are registered before show: a fast click or failure is never missed
    expect(this.listeners.has("click") && this.listeners.has("failed")).toBe(true);
    this.shown = true;
  }
  close() {
    this.closed = true;
  }
  on(event: string, l: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    return this;
  }
  emit(event: string) {
    for (const l of this.listeners.get(event) ?? []) l();
  }
}

function setup(supported = true) {
  FakeNotification.made = [];
  const badges: string[] = [];
  const opened: (number | null)[] = [];
  const shown: number[] = [];
  let failed = 0;
  const a = new DesktopAttention({
    setBadge: (t) => badges.push(t),
    supported: () => supported,
    create: (o) => new FakeNotification(o),
    open: (id) => opened.push(id),
    shown: (n) => shown.push(n),
    failed: () => void failed++,
  });
  return { a, badges, opened, shown, failed: () => failed };
}

describe("validation of what the backend reports", () => {
  it("a badge is a safe integer ≥ 0", () => {
    expect(parseBadge(0)).toBe(0);
    expect(parseBadge(12)).toBe(12);
    for (const bad of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) expect(parseBadge(bad)).toBeNull();
  });

  it("a notice: every field checked and bounded", () => {
    expect(parseNotice(notice())).toEqual(notice());
    expect(parseNotice(notice({ threadId: null }))).toMatchObject({ threadId: null });
    expect(parseNotice({ ...notice(), subject: "x".repeat(5000) })!.subject).toHaveLength(300);
    for (const bad of [null, "x", { ...notice(), count: 0 }, { ...notice(), threadId: -1 }, { ...notice(), threadId: "42" }, { ...notice(), senders: ["a", "b", "c", "d"] }, { ...notice(), senders: [] }, { ...notice(), senders: [3] }, { ...notice(), subject: 3 }, { ...notice(), id: "" }, { ...notice(), senderCount: 0 }])
      expect(parseNotice(bad)).toBeNull();
  });
});

describe("DesktopAttention", () => {
  it("the Dock: its text only when it changes, cleared at 0", () => {
    const t = setup();
    t.a.badge(3);
    t.a.badge(3);
    t.a.badge(12_345);
    t.a.badge(0);
    t.a.badge("junk");
    expect(t.badges).toEqual(["3", "9999+", ""]);
  });

  it("a notification: worded in the user's language, shown, recorded when it shows; a click opens its conversation", () => {
    const t = setup();
    t.a.notify(notice());
    const [n] = FakeNotification.made;
    expect(n!.options).toEqual({ title: "Ana Pérez", subtitle: "Presupuesto", body: "Te mando…", silent: false });
    expect(n!.shown).toBe(true);
    expect(t.shown).toEqual([]);
    n!.emit("show");
    expect(t.shown).toEqual([1]);
    n!.emit("click");
    expect(t.opened).toEqual([42]);
    expect(t.a.liveCount).toBe(0);
  });

  it("several senders: no subtitle, and a click opens the Inbox", () => {
    const t = setup();
    t.a.notify(notice({ count: 3, threadId: null, senders: ["Ana", "Bob"], senderCount: 2, snippet: "" }));
    expect(FakeNotification.made[0]!.options).toEqual({ title: "3 new messages", body: "From Ana and Bob", silent: false });
    FakeNotification.made[0]!.emit("click");
    expect(t.opened).toEqual([null]);
  });

  it("invalid notices and unsupported systems show nothing; a failure lets go of it", () => {
    const off = setup(false);
    off.a.notify(notice());
    expect(FakeNotification.made).toHaveLength(0);
    const t = setup();
    t.a.notify({ ...notice(), count: -1 });
    expect(FakeNotification.made).toHaveLength(0);
    t.a.notify(notice());
    FakeNotification.made[0]!.emit("failed");
    expect(t.a.liveCount).toBe(0);
    expect(t.failed()).toBe(1);
  });

  it("keeps at most MAX_LIVE references (closed ones go at once)", () => {
    const t = setup();
    for (let i = 0; i < MAX_LIVE + 5; i++) t.a.notify(notice({ id: `n${i}` }));
    expect(t.a.liveCount).toBe(MAX_LIVE);
    FakeNotification.made.at(-1)!.emit("close");
    expect(t.a.liveCount).toBe(MAX_LIVE - 1);
  });
});

describe("OpenRelay", () => {
  it("holds a click until the window's page listens, then delivers it once", () => {
    const sent: [number, number | null][] = [];
    const r = new OpenRelay((w, id) => sent.push([w, id]));
    r.want(1, 42);
    expect(sent).toEqual([]);
    r.listening(1);
    expect(sent).toEqual([[1, 42]]);
    r.listening(1);
    expect(sent).toHaveLength(1);
  });

  it("a page that went (reload) waits for the next one; a newer click replaces an undelivered one", () => {
    const sent: [number, number | null][] = [];
    const r = new OpenRelay((w, id) => sent.push([w, id]));
    r.listening(1);
    r.gone(1);
    r.want(1, 42);
    r.want(1, 43);
    expect(sent).toEqual([]);
    r.listening(1);
    expect(sent).toEqual([[1, 43]]);
    // a ready window gets it at once
    r.want(1, null);
    expect(sent).toEqual([[1, 43], [1, null]]);
  });
});
