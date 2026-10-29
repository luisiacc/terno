// @vitest-environment jsdom
import { body, construction, fixture, renderer } from "./forward-raw-obligation-test-utils";
import { act } from "react";
import { expect, it } from "vitest";
const { acquireDraftHold, attachBody, beginComposeBodyAckRead, editDraft, endDraftAckRead, flushDraft, materialize, readDraftAck, recipients } = await import("./drafts");
const { openCompose, supersedeCompose } = await import("./compose");
const { getApp, setApp } = await import("~/state/app");
const { runUndo, useSnack } = await import("./snack");

const quoteCases = [["SQL", false], ["IDB exact", true], ["IDB instant", true]] as const;
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

const sealCases = [["SQL", false], ["SQL", true], ["IDB exact", true], ["IDB instant", true]] as const;
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
