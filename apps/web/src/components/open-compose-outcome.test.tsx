// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import { setup } from "./draft-presentation-r1-harness";

// plan 56: an open that still matters never ends in silence
const opened = (h: Awaited<ReturnType<typeof setup>>) => Object.values(h.drafts.useDrafts.getState().drafts).filter((d) => d.mode === "reply" && d.inReplyToMessageId === 3);

it("a refresh that replaces the conversation mid-open is retried with it, and the reply opens", async () => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose"), { gate } = await import("./draft-presentation-r1-harness"), { useSnack } = await import("~/lib/snack");
  h.drafts.forgetDraft(h.key);
  useSnack.setState({ current: null });
  // the conversation's own read state, a sync or a landed send refetches it while the quote is measured: a new object
  let calls = 0;
  gate.load.mockImplementation(async (id: number) => {
    calls++;
    const detail = calls === 2 ? ({ ...h.detail, thread: { ...h.detail.thread } } as ThreadDetail) : h.detail;
    h.useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) }));
    return detail;
  });
  try {
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(calls).toBeGreaterThan(2);
    expect(opened(h)).toHaveLength(1);
    expect(useSnack.getState().current?.tone).not.toBe("error");
  } finally { await h.cleanup(); }
});

it.each(["sourceContext", "load"] as const)("a failure while the reply still matters says so (%s)", async (failing) => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose"), { gate } = await import("./draft-presentation-r1-harness"), { useSnack } = await import("~/lib/snack");
  h.drafts.forgetDraft(h.key);
  useSnack.setState({ current: null });
  if (failing === "sourceContext") gate.call.mockImplementation(async (method: string) => { if (method === "drafts.sourceContext") throw new Error("offline"); return {}; });
  else {
    h.useThreads.setState({ details: new Map() });
    gate.load.mockImplementation(async () => null);
  }
  try {
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(opened(h)).toHaveLength(0);
    expect(useSnack.getState().current).toMatchObject({ tone: "error", message: "Couldn't start the reply. Try again." });
  } finally { await h.cleanup(); }
});

it("a reply superseded by a newer choice stays silent", async () => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose"), { gate } = await import("./draft-presentation-r1-harness"), { useSnack } = await import("~/lib/snack");
  h.drafts.forgetDraft(h.key);
  useSnack.setState({ current: null });
  gate.call.mockImplementation(async (method: string) => {
    if (method === "drafts.sourceContext") { h.app.setApp({ selectedId: null, readerOpen: false }); throw new Error("offline"); }
    return {};
  });
  try {
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(useSnack.getState().current?.tone).not.toBe("error");
  } finally { await h.cleanup(); }
});

it.each(["stale", "failed"] as const)("once the user moved focus elsewhere, a %s open neither retries into focus nor complains", async (outcome) => {
  const h = await setup("split", true);
  const { openCompose } = await import("~/lib/compose"), { gate } = await import("./draft-presentation-r1-harness"), { useSnack } = await import("~/lib/snack");
  h.drafts.forgetDraft(h.key);
  useSnack.setState({ current: null });
  let calls = 0;
  gate.load.mockImplementation(async (id: number) => {
    calls++;
    if (calls === 2) h.other.focus(); // the user went to another control while the reply was opening
    const detail = outcome === "stale" && calls === 2 ? ({ ...h.detail, thread: { ...h.detail.thread } } as ThreadDetail) : h.detail;
    h.useThreads.setState((s) => ({ details: new Map(s.details).set(id, detail) }));
    return detail;
  });
  if (outcome === "failed") gate.call.mockImplementation(async (method: string) => { if (method === "drafts.sourceContext") throw new Error("offline"); return {}; });
  try {
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.other);
    expect(opened(h)).toHaveLength(0); // no retry opened it behind the user's back
    expect(useSnack.getState().current?.tone).not.toBe("error");
  } finally { await h.cleanup(); }
});

it("the menu counts a reply as opened inline or in the reader pane (a stored draft whose source moved)", async () => {
  const h = await setup("split", true);
  const { replyOpened } = await import("./thread-menu"), { openCompose } = await import("~/lib/compose");
  h.drafts.forgetDraft(h.key);
  try {
    expect(replyOpened(7, null)).toBe(false);
    // in the reader pane
    await act(async () => { h.app.setApp({ compose: { key: "pane", seq: 1 } }); });
    expect(replyOpened(7, null)).toBe(true);
    expect(replyOpened(7, h.app.getApp().compose)).toBe(false);
    await act(async () => { h.app.setApp({ compose: null }); });
    // inline in its conversation
    await act(async () => { await openCompose("reply", 7); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(opened(h)).toHaveLength(1);
    expect(replyOpened(7, null)).toBe(true);
  } finally { await h.cleanup(); }
});
