// @vitest-environment jsdom
import { DIGEST_ROW_ID, type ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { beforeEach, expect, it, vi } from "vitest";
import { setApp } from "~/state/app";
import { copyOpenThread, copyThreadText } from "./copy-thread";

vi.hoisted(() => vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
const h = vi.hoisted(() => ({ call: vi.fn(), load: vi.fn(), snack: Object.assign(vi.fn((_message: string, _o?: unknown) => "notice"), { error: vi.fn() }), dismiss: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: h.call, on: vi.fn(), connectionVersion: 1 } }));
vi.mock("~/state/threads", () => ({ loadThread: h.load }));
vi.mock("~/lib/snack", () => ({ snack: h.snack, dismissSnack: h.dismiss }));

class Item {
  constructor(readonly parts: Record<string, Promise<Blob>>) {}
}
const write = vi.fn(async ([item]: Item[]) => {
  await item!.parts["text/plain"];
});

const message = (id: number, bodyState: string, bodyText: string | null) => ({ id, from: { email: "a@x.io", name: "" }, to: [], cc: [], date: 0, bodyText, bodyHtml: null, bodyState, attachments: [] });
const detail = (...messages: ReturnType<typeof message>[]) => ({ thread: { subject: "S" }, messages }) as unknown as ThreadDetail;
const copied = async () => (await (write.mock.calls[0]![0][0] as Item).parts["text/plain"]!).text();

beforeEach(() => {
  setLocale("en", en);
  vi.clearAllMocks();
  vi.stubGlobal("ClipboardItem", Item);
  vi.stubGlobal("navigator", { clipboard: { write } });
  Blob.prototype.text ??= function (this: Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };
  setApp({ selectedId: 5, dialog: null, menuOpen: false, compose: null, scope: null, checked: new Set() });
});

it("starts the write inside the click, before anything has loaded", () => {
  h.load.mockReturnValue(new Promise(() => {}));
  copyThreadText(5);
  expect(write).toHaveBeenCalledTimes(1);
});

it("copies what's there and says how many, without asking for a download", async () => {
  h.load.mockResolvedValue(detail(message(1, "full", "One"), message(2, "full", "Two")));
  copyThreadText(5);
  await vi.waitFor(() => expect(h.snack).toHaveBeenCalledWith("Copied 2 messages", { duration: 2000 }));
  expect(await copied()).toContain("One");
  expect(h.call).not.toHaveBeenCalled();
});

it("downloads the bodies a conversation doesn't have yet, then copies them", async () => {
  h.load.mockResolvedValueOnce(detail(message(1, "full", "One"), message(2, "none", null))).mockResolvedValueOnce(detail(message(1, "full", "One"), message(2, "full", "Two")));
  h.call.mockResolvedValue({ changed: true });
  copyThreadText(5);
  await vi.waitFor(() => expect(h.snack).toHaveBeenCalledWith("Copied 2 messages", { duration: 2000 }));
  expect(h.call.mock.calls).toEqual([["reader.hydrate", { threadId: 5, messageId: 2 }]]);
  expect(h.snack).toHaveBeenCalledWith("Downloading…");
  expect(h.dismiss).toHaveBeenCalledWith("notice");
  expect(await copied()).toContain("Two");
});

it("copies what it has when a download fails, and says so", async () => {
  h.load.mockResolvedValue(detail(message(1, "full", "One"), message(2, "none", null)));
  h.call.mockRejectedValue(new Error("offline"));
  copyThreadText(5);
  await vi.waitFor(() => expect(h.snack).toHaveBeenCalledWith("Copied, but 1 message isn’t fully downloaded. The text says which.", { duration: 2000 }));
  expect(await copied()).toContain("[Content not downloaded yet]");
});

it("says so when the conversation can't be read or the clipboard refuses", async () => {
  h.load.mockResolvedValue(null);
  write.mockImplementationOnce(([item]) => item!.parts["text/plain"]!.then(() => {}));
  copyThreadText(5);
  await vi.waitFor(() => expect(h.snack.error).toHaveBeenCalledWith("Couldn’t copy the conversation. Try again."));
  h.load.mockResolvedValue(detail(message(1, "full", "One")));
  write.mockRejectedValueOnce(new Error("denied"));
  copyThreadText(5);
  await vi.waitFor(() => expect(h.snack.error).toHaveBeenCalledTimes(2));
});

it("the palette copies the open conversation, never the digest's row", () => {
  h.load.mockReturnValue(new Promise(() => {}));
  setApp({ selectedId: DIGEST_ROW_ID });
  copyOpenThread();
  expect(write).not.toHaveBeenCalled();
  setApp({ selectedId: 5 });
  copyOpenThread();
  expect(write).toHaveBeenCalledTimes(1);
});
