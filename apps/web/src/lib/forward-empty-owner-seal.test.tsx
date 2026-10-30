// @vitest-environment jsdom
import { body, fixture } from "./test/forward-raw-obligation";
import { act } from "react";
import { expect, it } from "vitest";
const { beginComposeBodyAckRead, beginForwardEmptyOwnerRead, createDraft, editDraft, endDraftAckRead, flushDraft, forgetDraft, materialize, readDraftAck, recipients, sealForwardEmptyOwnerRead, setDraftUi, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { openCompose } = await import("./compose");
const { runUndo, useSnack } = await import("./snack");

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
