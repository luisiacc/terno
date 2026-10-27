// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import SignInPanel from "./sign-in-panel";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

