// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { ThreadDetail } from "@terno/core";
import type { DraftAckRead } from "./drafts";
import { setup, gate, deferred } from "../components/draft-presentation-r1-harness";

type DraftState = ReturnType<typeof import("./drafts")["useDrafts"]["getState"]>;
const schedules = ["normal child", "completed raw then child", "raw restore", "raw still delivering", "no-op child", "held child"] as const;
const names = {
  "normal child": "frontier: late Forward after normal child close wins",
  "completed raw then child": "frontier: completed raw edge then certified child permits first Forward",
  "raw restore": "frontier: raw restore without a new child refuses first Forward",
  "raw still delivering": "frontier: an unknown traversal delivered after admission remains terminal",
  "no-op child": "frontier: a no-op child cannot rearm a compromised ancestor",
  "held child": "frontier: a held child cannot rearm a compromised ancestor",
};

for (const schedule of schedules) it(names[schedule], async () => {
  const { loadComposer } = await import("../components/composer/lazy");
  await loadComposer();
  const h = await setup("split", true), waiting = deferred<ThreadDetail>();
  const { openCompose, supersedeCompose } = await import("./compose");
  const { resetForwardFiles } = await import("./forward-files");
  let offFirst = () => {}, offLater = () => {}, offChild = () => {};
  let outer: DraftState | undefined, outerBefore: DraftState | undefined, raw: DraftState | undefined;
  let afterFirst: DraftState | undefined, afterChild: DraftState | undefined;
  let entered = false, requested = false, childEntered = false, childPublications = 0;
  let operation: Promise<void> | undefined;
  const phases: string[] = [];
  try {
    await act(async () => h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: "collapsed" }));
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    expect(before).toMatchObject({ mode: "reply", uiState: "collapsed", generation: "stable" });
    h.other.focus(); gate.load.mockClear(); gate.load.mockReturnValue(waiting.promise);
    offChild = h.drafts.useDrafts.subscribe((state, previous) => {
      if (entered && state.drafts[h.key]?.uiState === "collapsed" && previous.drafts[h.key]?.uiState === "open") childPublications++;
    });
    const child = () => {
      childEntered = true;
      h.drafts.setDraftUi(h.key, schedule === "no-op child" ? "open" : "collapsed");
      afterChild = h.drafts.useDrafts.getState();
      phases.push("child-returned");
    };
    offFirst = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!entered && state.drafts[h.key]?.uiState === "open" && previous.drafts[h.key]?.uiState === "collapsed") {
        entered = true; outer = state; outerBefore = previous;
        if (schedule === "raw still delivering") {
          raw = { ...state, drafts: { ...state.drafts } };
          h.drafts.useDrafts.setState(raw, true); phases.push("raw-returned");
        } else {
          if (schedule !== "normal child") {
            h.drafts.useDrafts.setState({ ...state, drafts: { ...state.drafts, [h.key]: { ...state.drafts[h.key]!, subject: "temporary raw edge" } } }, true);
            h.drafts.useDrafts.setState(state, true); phases.push("raw-returned");
          }
          if (schedule === "held child") {
            const release = h.drafts.acquireDraftHold();
            try { expect(release).not.toBeNull(); child(); } finally { release?.(); }
          } else if (schedule !== "raw restore") child();
        }
        afterFirst = h.drafts.useDrafts.getState();
      } else if (schedule === "raw still delivering" && state === raw && !childEntered) child();
    });
    offLater = h.drafts.useDrafts.subscribe((state, previous) => {
      // Zustand supplies live current state with this emission's captured previous state.
      const expected = schedule === "raw still delivering" ? afterChild : afterFirst;
      const delivery = expected !== undefined && state === expected && previous === (schedule === "raw still delivering" ? outer : outerBefore);
      if (!delivery || requested) return;
      requested = true; phases.push("requested"); operation = openCompose("forward", 7);
    });
    await act(async () => h.drafts.setDraftUi(h.key, "open"));
    expect(entered).toBe(true); expect(requested).toBe(true); expect(operation).toBeDefined();
    expect(childPublications).toBe(schedule === "normal child" || schedule === "completed raw then child" || schedule === "raw still delivering" ? 1 : 0);
    if (schedule === "normal child" || schedule === "completed raw then child") {
      expect(afterFirst).toBe(afterChild); expect(afterChild?.drafts[h.key]?.uiState).toBe("collapsed");
    }
    if (schedule === "completed raw then child") {
      expect(phases.indexOf("raw-returned")).toBeLessThan(phases.indexOf("child-returned"));
      expect(phases.indexOf("child-returned")).toBeLessThan(phases.indexOf("requested"));
    }
    if (schedule === "raw still delivering") expect(phases.indexOf("requested")).toBeLessThan(phases.indexOf("raw-returned"));
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    await act(async () => { gate.load.mockResolvedValue(h.detail); waiting.resolve(h.detail); await operation; });
    for (let i = 0; i < 5; i++) await h.flush();
    const current = h.drafts.useDrafts.getState().drafts[h.key]!;
    const positive = schedule === "normal child" || schedule === "completed raw then child";
    expect(current.mode).toBe(positive ? "forward" : "reply");
    expect(current).toMatchObject({ key: h.key, id: before.id, generation: before.generation, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    if (positive) {
      const to = h.host.querySelector('[data-testid="compose-to"]'); expect(to).not.toBeNull(); expect(document.activeElement).toBe(to);
    } else expect(h.app.getApp().draftFocus).toBeNull();
  } finally {
    offFirst(); offLater(); offChild(); waiting.resolve(h.detail);
    await Promise.allSettled(operation ? [operation] : []); supersedeCompose(); resetForwardFiles(); await h.cleanup();
  }
});

for (const later of ["hold", "source change"] as const) it(`frontier: later ${later} retires a consumed ancestor receipt`, async () => {
  const { loadComposer } = await import("../components/composer/lazy"); await loadComposer();
  const h = await setup("split", true), { controllerFor } = await import("../components/composer/controller");
  let entered = false, token: DraftAckRead | undefined, offFirst = () => {}, offLater = () => {}; const hold: { release: (() => void) | null } = { release: null };
  let child: DraftState | undefined, beforeOuter: DraftState | undefined;
  try {
    const controller = controllerFor(h.key); expect(controller).not.toBeNull();
    offFirst = h.drafts.useDrafts.subscribe((state, previous) => {
      if (entered || state.drafts[h.key]?.uiState !== "collapsed" || previous.drafts[h.key]?.uiState !== "open") return;
      entered = true; beforeOuter = previous; h.drafts.setDraftUi(h.key, "open"); child = h.drafts.useDrafts.getState();
    });
    offLater = h.drafts.useDrafts.subscribe((state, previous) => {
      if (!child || state !== child || previous !== beforeOuter || token) return;
      const admission = h.drafts.beginDraftAckRead(h.drafts.useDrafts.getState().drafts[h.key]!);
      if (admission.kind !== "refused") token = admission.kind === "proof" ? admission.proof : admission.continuity;
    });
    await act(async () => h.drafts.setDraftUi(h.key, "collapsed"));
    expect(entered).toBe(true); expect(token).toBeDefined();
    expect(controllerFor(h.key)).toBe(controller);
    expect(h.drafts.readDraftAck(token!)).toBe(h.drafts.useDrafts.getState().drafts[h.key]);
    if (later === "hold") {
      await act(async () => { hold.release = h.drafts.acquireDraftHold(); expect(hold.release).not.toBeNull(); hold.release?.(); hold.release = null; });
    } else await act(async () => controller!.run("quote"));
    expect(h.drafts.readDraftAck(token!)).toBeUndefined();
    expect(h.drafts.useDrafts.getState().drafts[h.key]?.bodyText).toContain("exact authored work");
    if (later === "source change") expect(controller!.dom.querySelector("blockquote")).not.toBeNull();
  } finally { offFirst(); offLater(); hold.release?.(); if (token) h.drafts.endDraftAckRead(token); await h.cleanup(); }
});
