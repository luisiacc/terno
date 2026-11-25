// @vitest-environment jsdom
/**
 * Plan 259 stage 3: an Outlook account in the renderer. Add account's Continue with Microsoft (busy and failure shared
 * with Google's, parameterised by method), an Outlook.com address typed in the IMAP form pointed to it, the sign-in
 * panel's Microsoft action, Settings' row and its Reconnect, the owner card, and the remove dialog's way to withdraw
 * Terno's access at Microsoft.
 */
import type { Account } from "@terno/core";
import type { OwnerIdentity } from "@terno/core/rpc";
import { RpcError } from "@terno/core/rpc";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
vi.hoisted(() => Object.assign(globalThis, { matchMedia: (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }) }));

// each call waits until the test settles it
const calls = vi.hoisted(() => [] as { method: string; params: unknown; settle: (value?: unknown, error?: Error) => void }[]);
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => new Promise((resolve, reject) => calls.push({ method, params, settle: (value, error) => (error ? reject(error) : resolve(value)) })),
    on: () => () => {},
  },
}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/open-link", () => ({ openLink: (href: string) => opened.push(href) }));

const { AddAccountForm, EMPTY_ACCOUNT_DRAFT, microsoftDomain } = await import("./add-account-dialog");
const { default: SignInPanel } = await import("./sign-in-panel");
const { AccountRemoveDialog, MICROSOFT_APPS } = await import("./account-remove-dialog");
const { AccountsTab, serviceLabel } = await import("./settings/accounts-tab");
const { OwnerCard } = await import("./settings/owner-card");
const { resetSignIn } = await import("~/lib/sign-in");
const { setApp } = await import("~/state/app");

const outlook = (patch: Partial<Account["syncState"]> = {}): Account =>
  ({ id: 7, kind: "outlook", email: "ana@outlook.com", displayName: "Ana", color: "brown", senderName: "Ana", signature: "", syncWindowDays: null, syncState: { status: "idle", authScope: null, ...patch } }) as unknown as Account;

let cleanup: (() => void) | null = null;
beforeEach(() => {
  setLocale("en", en);
  resetSignIn();
  calls.length = 0;
  opened.length = 0;
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  setApp({ accounts: [], owner: null, host: null });
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => act(() => root.unmount());
  return host;
}

const q = <T extends HTMLElement = HTMLElement>(testId: string) => document.querySelector<T>(`[data-testid="${testId}"]`);
const settle = (value?: unknown, error?: Error) => act(async () => { calls.at(-1)!.settle(value, error); await new Promise((r) => setTimeout(r, 0)); });

function Form({ onDone = () => {} }: { onDone?: () => void }) {
  const [draft, setDraft] = useState(EMPTY_ACCOUNT_DRAFT);
  return <AddAccountForm draft={draft} onDraft={setDraft} onDone={onDone} />;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Add account (plan 259)", () => {
  it("Continue with Microsoft sits beside Google's and connects with the chosen window; one way at a time", async () => {
    const done = vi.fn();
    await render(<Form onDone={done} />);
    const google = q<HTMLButtonElement>("connect-gmail")!, microsoft = q<HTMLButtonElement>("connect-microsoft")!;
    expect(microsoft.textContent!.trim()).toBe("Continue with Microsoft");
    // the pair, stacked in one group, Google first
    expect(microsoft.parentElement).toBe(google.parentElement);
    expect(google.nextElementSibling).toBe(microsoft);
    await act(async () => microsoft.click());
    expect(calls).toEqual([expect.objectContaining({ method: "accounts.connectMicrosoft", params: { syncWindowDays: 180 } })]);
    // busy: Microsoft's spins, Google's and the IMAP form wait
    expect(microsoft.getAttribute("aria-busy")).toBe("true");
    expect(google.getAttribute("aria-busy")).toBeNull();
    expect(google.getAttribute("aria-disabled")).toBe("true");
    expect(q<HTMLButtonElement>("imap-submit")!.getAttribute("aria-disabled")).toBe("true");
    await settle({ email: "ana@outlook.com" });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a refused Microsoft sign-in says so under the buttons, not under the IMAP form", async () => {
    await render(<Form />);
    await act(async () => q("connect-microsoft")!.click());
    await settle(undefined, new RpcError("BAD_REQUEST", "Your organization’s administrator has to allow Terno before you can connect this account. Ask them to approve it, then try again."));
    const error = q("add-account-error")!;
    expect(error.textContent).toContain("administrator has to allow Terno");
    // after the buttons' row, before the IMAP divider
    expect(q("connect-microsoft")!.parentElement!.nextElementSibling).toBe(error);
    expect(q("connect-microsoft")!.getAttribute("aria-busy")).toBeNull();
  });

  it("an Outlook.com address in the IMAP form points to Continue with Microsoft, with no Office 365 servers filled in", async () => {
    await render(<Form />);
    const email = q<HTMLInputElement>("imap-email")!;
    await type(email, "ana@hotmail.co.uk");
    const hint = q("imap-microsoft-hint")!;
    expect(hint.textContent).toBe("hotmail.co.uk no longer takes passwords from other apps. Continue with Microsoft");
    expect(email.getAttribute("aria-describedby")).toBe(hint.id);
    expect(q<HTMLInputElement>("imap-host")!.value).toBe("imap.hotmail.co.uk");
    await act(async () => q("imap-microsoft-connect")!.click());
    expect(calls.map((c) => c.method)).toEqual(["accounts.connectMicrosoft"]);
    await type(email, "ana@icloud.com");
    expect(q("imap-microsoft-hint")).toBeNull();
    expect(email.getAttribute("aria-describedby")).toBeNull();
  });

  it("knows Outlook.com's domains and their country versions, and nothing else", () => {
    for (const a of ["a@outlook.com", "a@Hotmail.com", "a@live.com", "a@msn.com", "a@outlook.es", "a@hotmail.co.uk", "a@live.com.mx", " a@live.fr "]) expect(microsoftDomain(a)).not.toBeNull();
    for (const a of ["a@contoso.com", "a@outlook.contoso.com", "a@myhotmail.com", "a@live.example.org", "a@gmail.com", "a@", "outlook.com"]) expect(microsoftDomain(a)).toBeNull();
  });
});

describe("signing an Outlook account in again (plan 259)", () => {
  it("the panel's action is Continue with Microsoft; while its page is open it waits and offers it again", async () => {
    await render(<Popover open><PopoverTrigger render={<button>Open</button>} /><PopoverContent><SignInPanel accounts={[outlook({ authRequired: true } as never)]} onLater={() => {}} /></PopoverContent></Popover>);
    const action = q<HTMLButtonElement>("sign-in-microsoft")!;
    expect(action.textContent).toBe("Continue with Microsoft");
    await act(async () => action.click());
    expect(calls).toEqual([expect.objectContaining({ method: "accounts.reconnect", params: { id: 7, password: undefined } })]);
    expect(q("sign-in-waiting")!.textContent).toBe("Finish in your browser");
    await act(async () => q("sign-in-microsoft-again")!.click());
    expect(calls).toHaveLength(2);
    await settle({});
    expect(q("sign-in-waiting")).toBeNull();
  });

  it("Settings names the service Outlook, and its Reconnect signs in with Microsoft", async () => {
    expect([serviceLabel("gmail"), serviceLabel("outlook"), serviceLabel("imap")]).toEqual(["Gmail", "Outlook", "IMAP/SMTP"]);
    const account = outlook();
    setApp({ accounts: [account], owner: null, settingsAccount: account.id } as never);
    await render(<AccountsTab settings={{ syncWindowDays: 180, accountCounts: false } as never} update={async () => {}} />);
    expect(q("account-toggle")!.textContent).toContain("ana@outlook.com · Outlook · Up to date");
    const reconnect = q<HTMLButtonElement>("account-reconnect")!;
    expect(reconnect.textContent!.trim()).toBe("Connect with Microsoft");
    await act(async () => reconnect.click());
    expect(calls.filter((c) => c.method === "accounts.reconnect")).toEqual([expect.objectContaining({ params: { id: 7, password: undefined } })]);
  });
});

describe("the owner card (plan 259)", () => {
  it("says the Terno account was verified with Microsoft", async () => {
    const owner = { accountId: 7, email: "ana@outlook.com", displayName: "Ana", provider: "outlook", verifiedBy: "microsoft_oauth", verifiedAt: Date.UTC(2026, 10, 24, 12), migrated: false } as unknown as OwnerIdentity;
    const host = await render(<OwnerCard owner={owner} demo={false} accounts={[outlook()]} />);
    expect(host.textContent).toContain("Verified with Microsoft · Nov 24, 2026");
  });
});

describe("removing an Outlook account (plan 259)", () => {
  it("says Terno can't withdraw its access at Microsoft and links where the person can; Cancel keeps focus", async () => {
    await render(<AccountRemoveDialog account={outlook()} open onOpenChange={() => {}} from="settings" />);
    const dialog = q("account-remove-dialog")!;
    expect(dialog.textContent).toContain("Your mail in Outlook doesn’t change. Terno can’t withdraw its own access at Microsoft");
    // Cancel, not the first link, has focus (Base UI would take the first tabbable)
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => q("account-remove-microsoft-personal")!.click());
    await act(async () => q("account-remove-microsoft-work")!.click());
    expect(opened).toEqual([MICROSOFT_APPS.personal, MICROSOFT_APPS.work]);
    expect(MICROSOFT_APPS).toEqual({ personal: "https://account.live.com/consent/Manage", work: "https://myapplications.microsoft.com/" });
  });
});
