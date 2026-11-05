// @vitest-environment jsdom
// The empty-owner read Forward takes from the real editor: who may exchange, seal or drop it.
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { DraftAckRead } from "./drafts";
import { body, construction, fixture, renderer } from "./test/forward-raw-obligation";

const { beginComposeBodyAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, materialize, readDraftAck, recipients, sealForwardEmptyOwnerRead, setDraftUi, useDrafts, acquireDraftHold, attachBody, beginDraftAckRead } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { openCompose, supersedeCompose } = await import("./compose");
const { runUndo, useSnack } = await import("./snack");
const { getApp, setApp } = await import("~/state/app");
const { controllerFor } = await import("../components/composer/controller");
const { keptState } = await import("../components/composer/editor");

describe("the same raw seal", () => {
  it("same raw seal: no-Writer admission refuses without retiring strict continuity", async () => {
    await fixture("SQL", true, false, async (f) => {
      const key = createDraft({ ...newFields(f.before.accountId), ...body });
      const a = beginComposeBodyAckRead(useDrafts.getState().drafts[key]!);
      expect(a.kind).toBe("no-writer");
      if (a.kind !== "no-writer") throw new Error("Expected no-writer continuity");
      try {
        expect(beginForwardEmptyOwnerRead(a.continuity)).toBeUndefined();
        expect(readDraftAck(a.continuity)).toBe(useDrafts.getState().drafts[key]);
      } finally { endDraftAckRead(a.continuity); forgetDraft(key); }
    });
  });
  it("same raw seal: early dirty seal refuses and exact author later seals", async () => {
    await fixture("SQL", true, false, async (f) => {
      const strict = f.admit()!, author = f.exchange(strict)!; expect(author).toBeDefined();
      expect(f.current().savedRev).toBeLessThan(f.current().localRev);
      expect(sealForwardEmptyOwnerRead(author)).toBeUndefined(); expect(readDraftAck(author)).toBe(f.current());
      await flushDraft(f.key); const sealed = sealForwardEmptyOwnerRead(author); expect(sealed).toBeDefined();
      try { await f.mount(); expect(readDraftAck(sealed!)).toBe(f.current()); } finally { if (sealed) endDraftAckRead(sealed); }
    });
  });
  it("same raw seal: stale predecessor cleanup preserves sealed raw arrival", async () => {
    await fixture("SQL", true, false, async (f) => {
      const strict = f.admit()!, author = f.exchange(strict)!; await flushDraft(f.key);
      const sealed = sealForwardEmptyOwnerRead(author); expect(sealed).toBeDefined();
      try {
        endDraftAckRead(strict); endDraftAckRead(author); await f.mount();
        expect(f.controller()?.dom.textContent).toBe(body.bodyText); expect(readDraftAck(sealed!)).toBe(f.current());
        endDraftAckRead(author); expect(readDraftAck(sealed!)).toBe(f.current());
      } finally { if (sealed) endDraftAckRead(sealed); }
    });
  });
  it("same raw seal: parked author carries no implicit remount reservation", async () => {
    await fixture("SQL", true, false, async (f) => {
      const strict = f.admit()!; await f.mount(); await f.unmount(); expect(readDraftAck(strict)).toBe(f.current());
      const author = f.exchange(strict); expect(author).toBeDefined(); expect(readDraftAck(author!)).toBe(f.current());
      await f.mount(); expect(f.controller()?.dom.textContent).toBe(body.bodyText);
      expect(readDraftAck(author!)).toBeUndefined(); expect(sealForwardEmptyOwnerRead(author!)).toBeUndefined();
    });
  });
  it("same raw seal: unrelated active UI frame grants no phase shortcut", async () => {
    await fixture("SQL", true, false, async (f) => {
      await flushDraft(f.key); const strict = f.admit()!, author = f.exchange(strict)!;
      const other = createDraft(newFields(f.before.accountId)); let attempted = 0;
      const stop = useDrafts.subscribe((state, previous) => {
        if (!attempted && state.drafts[other]?.uiState === "collapsed" && previous.drafts[other]?.uiState === "open") {
          attempted++; expect(sealForwardEmptyOwnerRead(author)).toBeUndefined();
        }
      });
      try {
        setDraftUi(other, "collapsed"); expect(attempted).toBe(1); expect(readDraftAck(author)).toBe(f.current());
        const sealed = sealForwardEmptyOwnerRead(author); expect(sealed).toBeDefined(); if (sealed) endDraftAckRead(sealed);
      } finally { stop(); forgetDraft(other); }
    });
  });
  it("same raw seal: actual author source reset remains terminal", async () => {
    await fixture("SQL", true, false, async (f) => {
      const author = f.exchange(f.admit()!)!; await f.mount(); expect(readDraftAck(author)).toBe(f.current());
      await act(async () => { expect(editDraft(f.key, { bodyText: "accepted replacement", bodyHtml: "<p>accepted replacement</p>" })).toBe(true); });
      expect(f.controller()?.dom.textContent).toBe("accepted replacement"); expect(readDraftAck(author)).toBeUndefined();
      expect(sealForwardEmptyOwnerRead(author)).toBeUndefined(); await flushDraft(f.key); expect(f.current().bodyText).toBe("accepted replacement");
    });
  });
  it("same raw seal: strict coalesced edit and Undo cannot revive sealed proof", async () => {
    await fixture("SQL", true, false, async (f) => {
      const author = f.exchange(f.admit()!)!; await flushDraft(f.key); const sealed = sealForwardEmptyOwnerRead(author)!;
      expect(sealed).toBeDefined(); await f.mount(); expect(readDraftAck(sealed)).toBe(f.current());
      await act(async () => { f.controller()!.run("quote"); f.controller()!.run("undo"); });
      expect(readDraftAck(sealed)).toBeUndefined(); expect(f.controller()?.dom.textContent).toBe(body.bodyText);
      await flushDraft(f.key); expect(readDraftAck(sealed)).toBeUndefined(); expect(f.current().bodyText).toBe(body.bodyText);
    });
  });
  it("same raw seal: wrong phase and stale author preserve independent successor", async () => {
    await fixture("SQL", true, false, async (f) => {
      const first = f.admit()!; expect(sealForwardEmptyOwnerRead(first)).toBeUndefined(); expect(readDraftAck(first)).toBe(f.current());
      const author = f.exchange(first)!; const next = f.admit()!; expect(next).toBeDefined();
      expect(sealForwardEmptyOwnerRead(author)).toBeUndefined(); endDraftAckRead(first); endDraftAckRead(author);
      expect(readDraftAck(next)).toBe(f.current()); await f.mount(); expect(readDraftAck(next)).toBe(f.current());
    });
  });
  it("same raw seal: SQL revision quote persists then discharged author seals with stale cleanup", async () => {
    await fixture("SQL", true, false, async (f) => {
      const strict = f.admit()!, author = f.exchange(strict)!; expect(author).toBeDefined(); endDraftAckRead(strict);
      f.armSave(); expect(editDraft(f.key, { subject: "latest subject", subjectEdited: true, toText: "authored@example.test, extra@example.test" })).toBe(true);
      const flushing = f.work(flushDraft(f.key));
      await Promise.race([f.saveEntered.promise, flushing.then(() => { expect.fail("Flush finished before actual save response gate"); })]);
      expect(f.counts().saveGates).toBe(1); expect(f.armedSaves).toHaveLength(1);
      expect(f.armedSaves[0]).toMatchObject({ id: f.before.id, generation: f.before.generation, baseRevision: f.before.revision });
      await f.mount(); const actual = f.controller()!; expect(actual.dom.textContent).toBe(body.bodyText);
      await act(async () => actual.run("quote")); expect(actual.dom.querySelector("blockquote")?.textContent).toBe(body.bodyText);
      endDraftAckRead(strict); f.saveRelease.resolve(); await flushing; expect(readDraftAck(author)).toBe(f.current());
      const quoted = materialize(f.key)!; expect(quoted.bodyText).toBe("> raw authored work");
      expect((await f.list()).find((d) => d.id === quoted.id)).toMatchObject({ id: quoted.id, generation: quoted.generation, bodyText: quoted.bodyText, bodyHtml: quoted.bodyHtml, to: recipients(quoted.toText, quoted.auto.to) });
      await act(async () => actual.run("undo")); expect(actual.dom.querySelector("blockquote")).toBeNull();
      await flushDraft(f.key); expect(f.current().bodyText).toBe(body.bodyText); expect(f.current().subject).toBe("latest subject"); expect(f.current().toText).toBe("authored@example.test, extra@example.test");
      endDraftAckRead(strict); expect(readDraftAck(author)).toBe(f.current());
      await act(async () => actual.run("quote")); await flushDraft(f.key); expect(readDraftAck(author)).toBe(f.current());
      const sealed = sealForwardEmptyOwnerRead(author); expect(sealed).toBeDefined();
      endDraftAckRead(author); endDraftAckRead(strict); expect(readDraftAck(sealed!)).toBe(f.current());
      await act(async () => actual.run("undo")); expect(readDraftAck(sealed!)).toBeUndefined();
      await flushDraft(f.key); expect(f.current()).toMatchObject({ bodyText: body.bodyText, subject: "latest subject", toText: "authored@example.test, extra@example.test" });
      await f.reopen(f.current());
    });
  });
  it("same raw seal: SQL revision real Forward accepts late Rich and preserves Undo", async () => {
    await fixture("SQL", true, true, async (f) => {
      expect(f.before.mode).toBe("reply"); f.armSave(); f.armContext(); f.armAuthor();
      const conversion = f.work(openCompose("forward", f.threadId!));
      await Promise.race([f.saveEntered.promise, conversion.then(() => { expect.fail("Forward finished before real empty-owner save gate"); })]);
      expect(f.counts().saveGates).toBe(1); expect(f.armedSaves).toHaveLength(1);
      expect(f.armedSaves[0]).toMatchObject({ id: f.before.id, generation: f.before.generation, baseRevision: f.before.revision, mode: "reply", attachments: [] });
      expect(await Promise.race([f.authorEntered, conversion.then(() => { expect.fail("Forward finished before real empty-owner author-entry gate"); })])).toBe(true);
      expect(f.authorObservations()).toBe(1); expect(f.controller()).toBeNull(); f.saveRelease.resolve();
      await Promise.race([f.contextEntered.promise, conversion.then(() => { expect.fail("Forward finished before real post-flush sourceContext gate"); })]);
      expect(f.counts()).toEqual({ saveGates: 1, contextGates: 1, replyAckDelivered: true }); expect(f.current()).toMatchObject({ mode: "reply", status: "saved", attachments: [], bodyText: f.before.bodyText }); expect(f.current().savedRev).toBe(f.current().localRev);
      await f.mount(); expect(f.controller()?.dom.textContent).toBe(f.before.bodyText); f.contextRelease.resolve(); await conversion;
      expect(f.current()).toMatchObject({ key: f.key, mode: "forward", bodyText: f.before.bodyText }); expect(f.current().attachments).toHaveLength(1);
      await flushDraft(f.key); const forward = f.current();
      expect((await f.list()).find((d) => d.id === forward.id)).toMatchObject({ id: forward.id, generation: forward.generation, mode: "forward", bodyText: forward.bodyText, bodyHtml: forward.bodyHtml });
      const undo = useSnack.getState().undo; expect(undo).not.toBeNull(); await runUndo(undo!);
      expect(f.current()).toMatchObject({ key: f.key, mode: "reply", bodyText: f.before.bodyText, toText: f.before.toText });
      await flushDraft(f.key); await f.reopen(f.current());
    });
  });
});

describe("transfer and seal", () => {
  const quoteCases = [["SQL", false], ["IDB", true]] as const;
  for (const [adapter, saved] of quoteCases) it(`raw transfer: ${adapter} ${saved ? "revision" : "first save"} keeps actual Rich quote through real ACK`, async () => {
    await fixture(adapter, saved, false, async (f) => {
      const strict = f.admit(); expect(strict).toBeDefined();
      const author = f.exchange(strict!); expect(author).toBeDefined(); expect(readDraftAck(strict!)).toBeUndefined(); endDraftAckRead(strict!);
      f.armSave(); expect(editDraft(f.key, { subject: "latest subject", subjectEdited: true, toText: "authored@example.test, extra@example.test" })).toBe(true);
      const flushing = f.work(flushDraft(f.key));
      await Promise.race([f.saveEntered.promise, flushing.then(() => { expect.fail("Flush finished before actual save response gate"); })]);
      expect(f.counts().saveGates).toBe(1); expect(f.armedSaves).toHaveLength(1);
      expect(f.armedSaves[0]).toMatchObject({ id: f.before.id ?? undefined, generation: f.before.generation, baseRevision: saved ? f.before.revision : undefined });
      await f.mount(); const actual = f.controller(); expect(actual).not.toBeNull(); expect(actual!.dom.textContent).toBe(body.bodyText);
      await act(async () => actual!.run("quote")); expect(actual!.dom.querySelector("blockquote")?.textContent).toBe(body.bodyText);
      endDraftAckRead(strict!); // An old predecessor cannot cancel the transferred obligation or its actual source.
      f.saveRelease.resolve(); await flushing;
      expect(readDraftAck(author!)).toBe(f.current());
      const quoted = materialize(f.key)!; expect(quoted.bodyText).toBe("> raw authored work");
      const row = (await f.list() as Array<{ id: number; generation: string; bodyText: string; bodyHtml: string; to: unknown }>).find((d) => d.id === quoted.id)!;
      expect(row).toMatchObject({ id: quoted.id, generation: quoted.generation, bodyText: quoted.bodyText, bodyHtml: quoted.bodyHtml, to: recipients(quoted.toText, quoted.auto.to) });
      await act(async () => actual!.run("undo")); expect(actual!.dom.querySelector("blockquote")).toBeNull();
      await flushDraft(f.key); expect(f.current().bodyText).toBe(body.bodyText); expect(f.current().subject).toBe("latest subject");
      expect(f.current().toText).toBe("authored@example.test, extra@example.test");
      endDraftAckRead(strict!); expect(readDraftAck(author!)).toBe(f.current());
      await f.reopen(f.current());
    });
  });

  for (const scenario of ["unknown source", "hold", "constructor", "changed doc", "successor"] as const) it(`raw transfer: ${scenario} preserves exact terminal and successor rules`, async () => {
    await fixture("SQL", true, false, async (f) => {
      const strict = f.admit(); expect(strict).toBeDefined(); const author = f.exchange(strict!); expect(author).toBeDefined();
      if (scenario === "unknown source") {
        const source = attachBody(f.key, () => ({ text: body.bodyText, html: body.bodyHtml }));
        try { expect(readDraftAck(author!)).toBeUndefined(); expect(materialize(f.key)?.bodyText).toBe(body.bodyText); } finally { source.dispose(); }
      } else if (scenario === "hold") {
        const release = acquireDraftHold(); try { expect(release).not.toBeNull(); } finally { release?.(); }
        expect(readDraftAck(author!)).toBeUndefined();
      } else if (scenario === "constructor") {
        const error = new Error("expected entered constructor failure"); let entries = 0;
        construction.beforeView = () => { entries++; expect(beginComposeBodyAckRead(f.current()).kind).toBe("refused"); throw error; };
        await f.mount(); construction.beforeView = null;
        expect(entries).toBeGreaterThan(0); expect(f.controller()).toBeNull(); expect(readDraftAck(author!)).toBeUndefined();
        expect(materialize(f.key)?.bodyText).toBe(body.bodyText);
      } else if (scenario === "changed doc") {
        let registrations = 0;
        construction.registered = (key, actual) => {
          expect(key).toBe(f.key); registrations++; actual.run("quote");
          expect(actual.dom.querySelector("blockquote")?.textContent).toBe(body.bodyText);
        };
        await f.mount(); construction.registered = null;
        expect(registrations).toBe(1); expect(f.controller()?.dom.querySelector("blockquote")?.textContent).toBe(body.bodyText);
        expect(readDraftAck(author!)).toBeUndefined();
        expect(materialize(f.key)?.bodyText).toBe("> raw authored work");
      } else {
        // An independent FIRST consumer supersedes the old one; this is not re-proof of a failed continuation.
        const successor = f.admit(); expect(successor).toBeDefined(); expect(readDraftAck(author!)).toBeUndefined();
        endDraftAckRead(strict!); endDraftAckRead(author!); await f.mount();
        expect(f.controller()).not.toBeNull(); expect(readDraftAck(successor!)).toBe(f.current());
      }
      endDraftAckRead(strict!);
      if (scenario === "changed doc") expect(f.current()).toMatchObject({ key: f.key, id: f.before.id, generation: f.before.generation, bodyText: "> raw authored work" });
      else expect(f.current()).toMatchObject({ key: f.key, id: f.before.id, generation: f.before.generation, ...body });
    });
  });

  const sealCases = [["SQL", false], ["SQL", true], ["IDB", true]] as const;
  for (const [adapter, saved] of sealCases) it(`raw seal: ${adapter} ${saved ? "revision" : "first save"} ${adapter === "SQL" && saved ? "navigation cancels late open without losing work" : "real openCompose survives late actual Rich arrival"}`, async () => {
    await fixture(adapter, saved, true, async (f) => {
      expect(f.threadId).toBeDefined(); expect(f.before.mode).toBe("reply");
      f.armSave(); f.armContext(); f.armAuthor();
      const conversion = f.work(openCompose("forward", f.threadId!));
      await Promise.race([f.saveEntered.promise, conversion.then(() => { expect.fail("Forward finished before real empty-owner save gate"); })]);
      expect(f.counts().saveGates).toBe(1); expect(f.armedSaves).toHaveLength(1); expect(f.armedSaves[0]).toMatchObject({ mode: "reply", attachments: [] });
      const authorReturned = await Promise.race([f.authorEntered, conversion.then(() => { expect.fail("Forward finished before real empty-owner author-entry gate"); })]);
      expect(authorReturned).toBe(true); expect(f.authorObservations()).toBe(1);
      expect(f.controller()).toBeNull(); f.saveRelease.resolve();
      await Promise.race([f.contextEntered.promise, conversion.then(() => { expect.fail("Forward finished before real post-flush sourceContext gate"); })]);
      expect(f.counts()).toEqual({ saveGates: 1, contextGates: 1, replyAckDelivered: true });
      expect(f.current()).toMatchObject({ mode: "reply", status: "saved", attachments: [], bodyText: f.before.bodyText });
      expect(f.current().savedRev).toBe(f.current().localRev);
      if (adapter === "SQL" && saved) {
        const chosen = document.createElement("button"); chosen.textContent = "Later choice"; document.body.append(chosen);
        const focusRequest = getApp().draftFocus;
        try {
          setApp({ selectedId: null, readerOpen: false }); supersedeCompose(); chosen.focus();
          const afterChoice = getApp().draftFocus;
          const beforeReleaseDispatches = renderer.call.mock.calls.length;
          const beforeReleaseSaves = structuredClone(f.armedSaves);
          f.contextRelease.resolve(); await conversion;
          expect(renderer.call).toHaveBeenCalledTimes(beforeReleaseDispatches);
          expect(f.armedSaves).toEqual(beforeReleaseSaves);
          expect(document.activeElement).toBe(chosen); expect(getApp().selectedId).toBeNull();
          expect(getApp().draftFocus).toBe(afterChoice);
          expect(afterChoice === focusRequest || afterChoice === null).toBe(true);
          expect(f.current()).toMatchObject({ key: f.key, id: f.before.id, generation: f.before.generation, mode: "reply", ...body });
          await flushDraft(f.key); await f.reopen(f.current());
        } finally { chosen.remove(); }
        return;
      }
      // This actual response is issued after the real caller's post-flush seal. No private proof/API probe.
      await f.mount(); expect(f.controller()?.dom.textContent).toBe(f.before.bodyText);
      f.contextRelease.resolve(); await conversion;
      expect(f.current()).toMatchObject({ key: f.key, mode: "forward", bodyText: f.before.bodyText }); expect(f.current().attachments).toHaveLength(1);
      await flushDraft(f.key); const forward = f.current();
      const row = (await f.list() as Array<{ id: number; generation: string; mode: string; bodyText: string; bodyHtml: string }>).find((d) => d.id === forward.id)!;
      expect(row).toMatchObject({ id: forward.id, generation: forward.generation, mode: "forward", bodyText: forward.bodyText, bodyHtml: forward.bodyHtml });
      const undo = useSnack.getState().undo; expect(undo).not.toBeNull(); await runUndo(undo!);
      expect(f.current()).toMatchObject({ key: f.key, mode: "reply", bodyText: f.before.bodyText, toText: f.before.toText });
      await flushDraft(f.key); await f.reopen(f.current());
    });
  });
});

describe("author lineage", () => {
  const body = { bodyText: "exact authored work", bodyHtml: "<p>exact authored work</p>" };
  const names = {
    attached: "author lineage: actual attached RichBody permits exchange and persists accepted PM work",
    parked: "author lineage: actual owned RichBody departure permits parked exchange",
    strict: "author lineage: ordinary strict proof without body handoff still exchanges",
    source: "author lineage: ordinary strict source proof without certificate still exchanges",
    held: "author lineage: intervening real hold leaves raw proof terminal",
  };
  for (const scenario of ["attached", "parked", "strict", "source", "held"] as const) it(names[scenario], async () => {
    await fixture("SQL", true, false, async (f) => {
      const key = f.key, original = f.before, tokens: DraftAckRead[] = [];
      let source: ReturnType<typeof attachBody> | undefined, release: (() => void) | null = null;
      const capture = (admission: ReturnType<typeof beginDraftAckRead>) => {
        const token = admission.kind === "proof" ? admission.proof : admission.kind === "no-writer" ? admission.continuity : undefined;
        if (token) tokens.push(token); return token;
      };
      const exchange = (token: DraftAckRead) => { const result = beginForwardEmptyOwnerRead(token); if (result) tokens.push(result); return result; };
      try {
        expect(original).toMatchObject({ status: "saved", ...body }); expect(original.id).not.toBeNull(); expect(original.generation).toBeTruthy();
        expect(original.attachments?.length ?? 0).toBe(0); expect(original.attachmentOwner ?? false).toBe(false);
        expect(controllerFor(key)).toBeNull(); expect(keptState(key, original.bodyVersion)).toBeNull();
        if (scenario === "source") source = attachBody(key, () => ({ text: body.bodyText, html: body.bodyHtml }));
        const strict = scenario === "strict" || scenario === "source";
        const token = capture(strict ? beginDraftAckRead(original) : beginComposeBodyAckRead(original));
        expect(token).toBeDefined(); expect(readDraftAck(token!)).toBe(original);
        if (scenario === "attached" || scenario === "parked") {
          await f.mount();
          const controller = controllerFor(key); expect(controller).not.toBeNull(); expect(controller!.dom.textContent).toBe(body.bodyText);
          expect(readDraftAck(token!)).toBe(useDrafts.getState().drafts[key]);
          if (scenario === "parked") {
            await f.unmount();
            expect(controllerFor(key)).toBeNull(); expect(keptState(key, original.bodyVersion)).not.toBeNull();
            expect(readDraftAck(token!)).toBe(useDrafts.getState().drafts[key]);
          }
          const phase = exchange(token!); expect(phase).toBeDefined(); expect(readDraftAck(token!)).toBeUndefined(); expect(readDraftAck(phase!)).toBe(useDrafts.getState().drafts[key]);
          if (scenario === "attached") {
            await act(async () => controller!.run("quote")); expect(controller!.dom.querySelector("blockquote")?.textContent).toBe(body.bodyText);
            expect(materialize(key)?.bodyText).toBe("> exact authored work");
          }
        } else if (strict) {
          const phase = exchange(token!); expect(phase).toBeDefined(); expect(readDraftAck(token!)).toBeUndefined(); expect(readDraftAck(phase!)).toBe(useDrafts.getState().drafts[key]);
        } else {
          release = acquireDraftHold(); expect(release).not.toBeNull(); release?.(); release = null;
          expect(readDraftAck(token!)).toBeUndefined(); expect(exchange(token!)).toBeUndefined();
        }
        for (const t of tokens) endDraftAckRead(t);
        const accepted = materialize(key)!; await flushDraft(key); const final = useDrafts.getState().drafts[key]!;
        expect(final).toMatchObject({ key, id: original.id, generation: original.generation, bodyText: accepted.bodyText, bodyHtml: accepted.bodyHtml, status: "saved" });
        const row = (await f.list()).find((d) => d.id === final.id)!;
        expect(row).toMatchObject({ generation: final.generation, bodyText: accepted.bodyText, bodyHtml: accepted.bodyHtml, to: [{ name: "", email: "authored@example.test" }] });
        for (const request of f.requests) expect(request.to).toEqual([{ name: "", email: "authored@example.test" }]);
        const reopened = await f.reopen(final, true);
        expect(reopened).toMatchObject({ id: final.id, generation: final.generation, body_text: accepted.bodyText, body_html: accepted.bodyHtml });
      } finally { release?.(); for (const token of tokens) endDraftAckRead(token); source?.dispose(); }
    }, { body, pendingEdit: false });
  });
});
