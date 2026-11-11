// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import SignInPanel from "./sign-in-panel";

// plan 184 (code review #3): a sign-in that finishes later, on cue
const pending = vi.hoisted(() => ({ finish: null as null | ((ok: boolean) => void) }));
vi.mock("~/lib/sign-in", async (importActual) => ({
  ...(await importActual<typeof import("~/lib/sign-in")>()),
  signInAgain: vi.fn(() => new Promise<boolean>((resolve) => { pending.finish = resolve; })),
}));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
// focus settles a frame after a sign-in: a frame is a turn here
vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));

const account = (id: number) => ({ id, kind: "imap", email: `account${id}@example.test`, displayName: `Account ${id}`, color: "blue", senderName: "", signature: "", syncWindowDays: null, syncState: { authScope: null } }) as Account;

it.each([true, false])("keeps the same focused password field through two, one, and two accounts (returning first: %s)", async (returningFirst) => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const first = account(1), second = account(2);
  const render = async (accounts: Account[]) => act(async () => root.render(
    <StrictMode><Popover open><PopoverTrigger render={<button>Open</button>} /><PopoverContent><SignInPanel accounts={accounts} onLater={() => {}} /></PopoverContent></Popover></StrictMode>,
  ));
  try {
    await render([first, second]);
    await render([second]);
    const input = document.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "partial");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus(); input.setSelectionRange(2, 5);
    });
    expect(document.activeElement).toBe(input);
    await render(returningFirst ? [first, second] : [second, first]);
    expect(document.querySelector('[data-account-id="2"] [data-testid="sign-in-password"]')).toBe(input);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("partial");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("plan 184 (code review #3): a sign-in finishing after its panel closed leaves focus in another account's password field", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const home = document.createElement("button"); document.body.append(home);
  const root = createRoot(host);
  const google = { ...account(1), kind: "gmail" } as Account, imap = account(2);
  // each account's own popover (Settings' rows), never one reused for the other
  const panel = (a: Account) => <Popover key={a.id} open><PopoverTrigger render={<button>Open</button>} /><PopoverContent><SignInPanel accounts={[a]} home={() => home} onLater={() => {}} /></PopoverContent></Popover>;
  try {
    await act(async () => root.render(<StrictMode>{panel(google)}</StrictMode>));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sign-in-google"]')!.click());
    expect(pending.finish).not.toBeNull();
    // its panel closed (the Google page still open in the browser); another account's opened, a password typed
    await act(async () => root.render(<StrictMode>{panel(imap)}</StrictMode>));
    const input = document.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!;
    await act(async () => input.focus());
    await act(async () => { pending.finish!(true); await new Promise((r) => setTimeout(r, 50)); });
    expect(document.activeElement).toBe(input);
  } finally { await act(async () => root.unmount()); host.remove(); home.remove(); }
});
