// @vitest-environment jsdom
import type { AttachmentInfo, MessageDetail, ThreadDetail } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ retry: vi.fn(async (_args: unknown) => {}), download: vi.fn(async (_accountId: number, _ref: unknown) => {}) }));
vi.mock("~/rpc/connection", () => ({ client: { call: (method: string, args: unknown) => (method === "attachments.retry" ? calls.retry(args) : Promise.reject(new Error(method))) } }));
vi.mock("~/lib/attachments", async (original) => ({ ...(await original<typeof import("~/lib/attachments")>()), downloadAttachment: calls.download }));
vi.mock("~/lib/snack", () => ({ snack: Object.assign(vi.fn(), { error: vi.fn() }) }));
// what each avatar is asked for (icons, a person's), not the icon machinery: that's sender-avatar's own
vi.mock("./sender-avatar", () => ({ SenderAvatar: ({ icon, person }: { icon: boolean; person: boolean }) => <span aria-hidden data-testid="avatar" data-icon={String(icon)} data-person={String(person)} /> }));

// (the person menu reaches the composer, whose modules read the motion preference as they load)
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { ThreadAttachments } = await import("./attachments");
const { ThreadPeople } = await import("./thread-people");

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; calls.retry.mockClear(); calls.download.mockClear(); });

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

let n = 1;
const me = { name: "Luis", email: "luis@acme.studio" };
const person = (i: number) => ({ name: `Person${i} Last`, email: `p${i}@acme.studio` });
const msg = (o: Partial<MessageDetail> = {}): MessageDetail => ({ id: n++, accountId: 4, from: person(0), to: [me], cc: [], isSent: false, listId: null, attachments: [], ...o }) as MessageDetail;
const file = (id: number, assetId?: string): AttachmentInfo => ({ id, filename: `file-${id}.pdf`, size: 2048, mime: "application/pdf", ...(assetId ? { assetId } : {}) });
const peopleOf = (messages: MessageDetail[]) => <ThreadPeople detail={{ messages } as ThreadDetail} myEmails={[me.email]} icons={false} personOf={() => true} />;

describe("ThreadPeople (plan 177)", () => {
  it("isn't there for a single message", async () => {
    const host = await render(peopleOf([msg({ to: [me, person(1)] })]));
    expect(host.querySelector("[data-testid=thread-people]")).toBeNull();
  });

  it("isn't there for a one-to-one conversation: its headers say who (plan 194)", async () => {
    const host = await render(peopleOf([msg({ from: person(1) }), msg({ from: me, to: [person(1)], isSent: true }), msg({ from: person(1) })]));
    expect(host.querySelector("[data-testid=thread-people]")).toBeNull();
  });

  it("a named list of chips, each a menu button named by the full name and address; past six, a +N button shows the rest", async () => {
    const host = await render(peopleOf([msg({ to: [me, ...Array.from({ length: 8 }, (_, i) => person(i + 1))] }), msg({ from: person(1) })]));
    const list = host.querySelector("ul[data-testid=thread-people]")!;
    expect(list.getAttribute("aria-label")).toBe("People in this conversation");
    const chips = () => [...host.querySelectorAll("[data-testid=thread-person]")];
    expect(chips()).toHaveLength(6);
    // the avatar and the first name are hidden from screen readers; they hear the full name and address once
    expect(chips()[0]!.querySelector("[data-slot=chip-label] > [aria-hidden]")!.textContent).toBe("Person0");
    expect(chips()[0]!.querySelector(".sr-only")!.textContent).toBe("Person0 Last <p0@acme.studio>");
    // plan 180: each chip opens that person's menu
    expect(chips().every((c) => c.tagName === "BUTTON" && c.getAttribute("aria-haspopup") === "menu")).toBe(true);
    const more = host.querySelector<HTMLButtonElement>("[data-testid=thread-people-more]")!;
    expect(more.textContent).toBe("+3");
    expect(more.getAttribute("aria-label")).toBe("Show 3 more people");
    more.focus();
    await act(async () => more.click());
    expect(chips()).toHaveLength(9);
    // the same button, still focused, now folds them back
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe("Show fewer");
    await act(async () => more.click());
    expect(chips()).toHaveLength(6);
    expect(document.activeElement).toBe(more);
  });

  it("follows the reader's avatar rules as they change, with the same messages: a thread turning spam asks for no icon (plan 22)", async () => {
    const messages = [msg({ to: [me, person(1)] }), msg({ from: person(1), listId: "list.acme.studio" })];
    const detail = { messages } as ThreadDetail;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    const draw = (icons: boolean, people: boolean) => act(async () => root.render(<ThreadPeople detail={detail} myEmails={[me.email]} icons={icons} personOf={(m) => people && m.listId === null} />));
    const avatars = () => [...host.querySelectorAll("[data-testid=avatar]")].map((a) => `${a.getAttribute("data-icon")}/${a.getAttribute("data-person")}`);
    await draw(true, true);
    // person0 wrote outside the list; person1's newest is the list's
    expect(avatars()).toEqual(["true/true", "true/false"]);
    await draw(false, true);
    expect(avatars()).toEqual(["false/true", "false/false"]);
    await draw(false, false);
    expect(avatars()).toEqual(["false/false", "false/false"]);
  });
});

describe("ThreadAttachments (plan 177)", () => {
  it("isn't there for a single message, nor for a conversation without files", async () => {
    let host = await render(<ThreadAttachments messages={[msg({ attachments: [file(1, "a")] })]} />);
    expect(host.querySelector("[data-testid=thread-attachments]")).toBeNull();
    cleanup!();
    host = await render(<ThreadAttachments messages={[msg(), msg()]} />);
    expect(host.querySelector("[data-testid=thread-attachments]")).toBeNull();
  });

  it("gathers every message's files under a disclosure that folds them away", async () => {
    const host = await render(<ThreadAttachments messages={[msg({ attachments: [file(1, "a")] }), msg(), msg({ attachments: [file(2)] })]} />);
    const trigger = host.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!;
    expect(trigger.textContent).toBe("Attachments2");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const files = [...host.querySelectorAll("[data-testid=thread-attachment] button")];
    expect(files.map((b) => b.getAttribute("aria-label"))).toEqual(["Download file-1.pdf 2 KB", "Download file-2.pdf 2 KB · Unavailable offline"]);
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("a file does what its message's tile does: downloads what's cached, asks its own message for what isn't", async () => {
    const a = msg({ attachments: [file(1, "asset-1")] });
    const b = msg({ attachments: [file(2)] });
    const host = await render(<ThreadAttachments messages={[a, b]} />);
    const [cached, missing] = [...host.querySelectorAll<HTMLButtonElement>("[data-testid=thread-attachment] button")];
    await act(async () => cached!.click());
    expect(calls.download).toHaveBeenCalledWith(4, expect.objectContaining({ id: 1, assetId: "asset-1" }));
    await act(async () => missing!.click());
    expect(calls.retry).toHaveBeenCalledWith({ accountId: 4, messageId: b.id });
  });

  it("says which file is busy while its retry runs, and takes no second click meanwhile", async () => {
    let finish!: () => void;
    calls.retry.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const host = await render(<ThreadAttachments messages={[msg({ attachments: [file(1)] }), msg({ attachments: [file(2)] })]} />);
    const [first, second] = [...host.querySelectorAll<HTMLButtonElement>("[data-testid=thread-attachment] button")];
    await act(async () => first!.click());
    expect(first!.getAttribute("aria-busy")).toBe("true");
    expect(second!.getAttribute("aria-busy")).toBe("false");
    expect(second!.disabled).toBe(true);
    await act(async () => finish());
    expect(first!.getAttribute("aria-busy")).toBe("false");
  });

  it("past twelve files, the rest wait behind Show all", async () => {
    const host = await render(<ThreadAttachments messages={[msg({ attachments: Array.from({ length: 15 }, (_, i) => file(i + 1, `a${i}`)) }), msg()]} />);
    expect(host.querySelectorAll("[data-testid=thread-attachment]")).toHaveLength(12);
    const all = host.querySelector<HTMLButtonElement>("[data-testid=thread-attachments-all]")!;
    expect(all.textContent).toBe("Show all 15");
    all.focus();
    await act(async () => all.click());
    expect(host.querySelectorAll("[data-testid=thread-attachment]")).toHaveLength(15);
    expect(document.activeElement).toBe(all);
    expect(all.textContent).toBe("Show fewer");
    await act(async () => all.click());
    expect(host.querySelectorAll("[data-testid=thread-attachment]")).toHaveLength(12);
  });
});
