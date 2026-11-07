// Plan 158: closing a draft with nothing of the user's in it leaves nothing behind; anything of theirs keeps it.
import { describe, expect, it } from "vitest";
import { nothingWritten, type LocalDraft } from "./drafts";

const draft = (patch: Partial<LocalDraft> = {}) => ({ bodyText: "", bodyHtml: "", subjectEdited: false, toText: "", ccText: "", bccText: "", auto: { to: [], cc: [], bcc: [] }, sending: false, ...patch }) as LocalDraft;

describe("nothingWritten", () => {
  it("a blank new message, a forward, a reply with only the addresses Terno filled in", () => {
    expect(nothingWritten(draft())).toBe(true);
    expect(nothingWritten(draft({ toText: "Ana <ana@example.com>", ccText: "bob@example.com", auto: { to: ["ana@example.com"], cc: ["BOB@example.com"], bcc: [] } }))).toBe(true);
    expect(nothingWritten(draft({ bodyText: " \n " }))).toBe(true);
  });
  it.each<[string, Partial<LocalDraft>]>([
    ["text", { bodyText: "hola" }],
    ["an image with no text", { bodyHtml: '<p><img src="cid:a"></p>' }],
    ["their subject", { subjectEdited: true }],
    ["a recipient of theirs", { toText: "ana@example.com" }],
    ["something half typed", { toText: "ana@" }],
    ["one more than Terno filled in", { toText: "a@example.com, b@example.com", auto: { to: ["a@example.com"], cc: [], bcc: [] } }],
    ["a file", { attachments: [{}] as LocalDraft["attachments"] }],
    ["files that were sent up", { attachmentOwner: true }],
    ["recovery in progress", { recovery: { state: "missing" } as LocalDraft["recovery"] }],
    ["a send in flight", { sending: true }],
  ])("%s keeps it", (_name, patch) => {
    expect(nothingWritten(draft(patch))).toBe(false);
  });
});
