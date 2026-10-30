// @vitest-environment jsdom
import { fixture } from "./test/forward-raw-obligation";
import { act } from "react";
import { expect, it } from "vitest";
const { acquireDraftHold, attachBody, beginComposeBodyAckRead, beginDraftAckRead, beginForwardEmptyOwnerRead, endDraftAckRead, flushDraft, materialize, readDraftAck, useDrafts } = await import("./drafts");
const { controllerFor } = await import("../components/composer/controller");
const { keptState } = await import("../components/composer/editor");
import type { DraftAckRead } from "./drafts";

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
