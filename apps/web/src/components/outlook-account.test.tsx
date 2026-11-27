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

const { AddAccountDialog, AddAccountForm, EMPTY_ACCOUNT_DRAFT, microsoftDomain } = await import("./add-account-dialog");
const { default: SignInPanel } = await import("./sign-in-panel");
const { AccountRemoveDialog, MICROSOFT_APPS } = await import("./account-remove-dialog");
const { AccountsTab, serviceLabel } = await import("./settings/accounts-tab");
const { OwnerCard } = await import("./settings/owner-card");
const { resetSignIn } = await import("~/lib/sign-in");
const { getApp, setApp, useApp } = await import("~/state/app");

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

function Form({ onDone = () => {}, picked = null, way = "choose" }: { onDone?: () => void; picked?: number | null; way?: "choose" | "imap" }) {
  const [draft, setDraft] = useState({ ...EMPTY_ACCOUNT_DRAFT, picked, way });
  return <AddAccountForm draft={draft} onDraft={setDraft} onDone={onDone} />;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Add account (plan 259)", () => {
  it("Continue with Microsoft sits under Google's and connects with the chosen window; one way at a time", async () => {
    const done = vi.fn();
    // a window chosen other than the General one (Codex review #9)
    await render(<Form onDone={done} picked={365} />);
    const google = q<HTMLButtonElement>("connect-gmail")!, microsoft = q<HTMLButtonElement>("connect-microsoft")!;
    expect(microsoft.textContent!.trim()).toBe("Continue with Microsoft");
    // the pair, stacked in one group, Google first
    expect(microsoft.parentElement).toBe(google.parentElement);
    expect(google.nextElementSibling).toBe(microsoft);
    await act(async () => microsoft.click());
    expect(calls).toEqual([expect.objectContaining({ method: "accounts.connectMicrosoft", params: { syncWindowDays: 365 } })]);
    // busy: Microsoft's spins in its mark's place (the words stay), Google's and Other mail account wait
    expect(microsoft.getAttribute("aria-busy")).toBe("true");
    expect(microsoft.textContent!.trim()).toBe("Continue with Microsoft");
    expect(microsoft.querySelector("[data-provider-mark]")).toBeNull();
    expect(google.getAttribute("aria-busy")).toBeNull();
    expect(google.getAttribute("aria-disabled")).toBe("true");
    expect(q<HTMLButtonElement>("connect-imap")!.getAttribute("aria-disabled")).toBe("true");
    await settle({ email: "ana@outlook.com" });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a refused Microsoft sign-in says so under the buttons", async () => {
    await render(<Form />);
    await act(async () => q("connect-microsoft")!.click());
    await settle(undefined, new RpcError("BAD_REQUEST", "Your organization’s administrator has to allow Terno before you can connect this account. Ask them to approve it, then try again."));
    const error = q("add-account-error")!;
    expect(error.textContent).toContain("administrator has to allow Terno");
    // right after the buttons' column
    expect(q("connect-microsoft")!.parentElement!.nextElementSibling).toBe(error);
    expect(q("connect-microsoft")!.getAttribute("aria-busy")).toBeNull();
  });

  it("an Outlook.com address in the IMAP form points to Continue with Microsoft, with no Office 365 servers filled in", async () => {
    await render(<Form way="imap" />);
    const email = q<HTMLInputElement>("imap-email")!;
    const servers = () => [q<HTMLInputElement>("imap-host")!.value, q<HTMLInputElement>("smtp-host")!.value];
    // the two that had Office 365 presets (Codex review #8)
    await type(email, "ana@outlook.com");
    expect(servers()).toEqual(["imap.outlook.com", "smtp.outlook.com"]);
    await type(email, "ana@hotmail.com");
    expect(servers()).toEqual(["imap.hotmail.com", "smtp.hotmail.com"]);
    const hint = q("imap-microsoft-hint")!;
    expect(hint.textContent).toBe("hotmail.com no longer takes passwords from other apps. Continue with Microsoft");
    expect(email.getAttribute("aria-describedby")).toBe(hint.id);
    await act(async () => q("imap-microsoft-connect")!.click());
    expect(calls.map((c) => c.method)).toEqual(["accounts.connectMicrosoft"]);
    await settle(undefined, new RpcError("BAD_REQUEST", "Microsoft access was denied."));
    await type(email, "ana@icloud.com");
    expect(q("imap-microsoft-hint")).toBeNull();
    expect(email.getAttribute("aria-describedby")).toBeNull();
  });

  it("Codex review #3: started from the hint, its progress and its failure show at the hint", async () => {
    await render(<Form way="imap" />);
    await type(q<HTMLInputElement>("imap-email")!, "ana@outlook.com");
    await act(async () => q("imap-microsoft-connect")!.click());
    expect(q("imap-microsoft-connect")!.getAttribute("aria-busy")).toBe("true");
    // plan 276: the ways in aren't on screen beside the form
    expect(q("connect-microsoft")).toBeNull();
    await settle(undefined, new RpcError("BAD_REQUEST", "Microsoft access was denied."));
    const error = q("add-account-error")!;
    expect(error.textContent).toBe("Microsoft access was denied.");
    expect(q("imap-microsoft-hint")!.nextElementSibling).toBe(error);
    expect(q("imap-microsoft-connect")!.getAttribute("aria-busy")).toBeNull();
  });

  it("Codex review #1: a sign-in finishing after its dialog closed closes nothing (another Add account opened since)", async () => {
    // as the app draws it: only while it's the dialog
    function Host() {
      const open = useApp((s) => s.dialog === "addAccount");
      return open ? <AddAccountDialog /> : null;
    }
    setApp({ dialog: "addAccount" });
    await render(<Host />);
    await act(async () => q("connect-microsoft")!.click());
    await act(async () => setApp({ dialog: null }));
    await act(async () => setApp({ dialog: "addAccount" }));
    await act(async () => { calls.at(-1)!.settle({ email: "ana@outlook.com" }); await new Promise((r) => setTimeout(r, 0)); });
    expect(getApp().dialog).toBe("addAccount");
    expect(q("add-account-dialog")).not.toBeNull();
    setApp({ dialog: null });
  });

  it("Codex review round 2 #1: the first run's form gone first (the new account's event came before the answer), it's still finished", async () => {
    const done = vi.fn();
    await render(<Form onDone={done} />);
    await act(async () => q("connect-microsoft")!.click());
    cleanup!();
    cleanup = null;
    await act(async () => { calls.at(-1)!.settle({ email: "ana@outlook.com" }); await new Promise((r) => setTimeout(r, 0)); });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("Codex review round 2 #2: started from the hint and the address edited away, the failure still shows under it", async () => {
    await render(<Form way="imap" />);
    const email = q<HTMLInputElement>("imap-email")!;
    await type(email, "ana@outlook.com");
    await act(async () => q("imap-microsoft-connect")!.click());
    await type(email, "ana@icloud.com");
    // plan 276: the hint stays with its progress until the sign-in settles (the ways in aren't on screen to take it)
    expect(q("imap-microsoft-hint")!.textContent).toContain("outlook.com no longer takes passwords");
    expect(q("imap-microsoft-connect")!.getAttribute("aria-busy")).toBe("true");
    expect(q("imap-back")!.getAttribute("aria-disabled")).toBe("true");
    // the person on the hint's button meanwhile: it goes with the hint, and focus goes back to Email (Codex code review #3)
    q<HTMLButtonElement>("imap-microsoft-connect")!.focus();
    await settle(undefined, new RpcError("BAD_REQUEST", "Microsoft access was denied."));
    expect(q("imap-microsoft-hint")).toBeNull();
    expect(document.activeElement).toBe(email);
    expect(email.parentElement!.querySelector("[data-testid=add-account-error]")!.textContent).toBe("Microsoft access was denied.");
  });

  it("plan 276: the IMAP form is a step after Other mail account; Choose another way goes back with what was typed", async () => {
    await render(<Form />);
    expect(q("imap-email")).toBeNull();
    expect(q("connect-imap")!.textContent!.trim()).toBe("Other mail account IMAP/SMTP");
    await act(async () => q("connect-imap")!.click());
    expect(q("connect-gmail")).toBeNull();
    const email = q<HTMLInputElement>("imap-email")!;
    expect(document.activeElement).toBe(email);
    await type(email, "ana@icloud.com");
    await act(async () => q("imap-back")!.click());
    expect(q("imap-email")).toBeNull();
    expect(document.activeElement).toBe(q("connect-imap"));
    await act(async () => q("connect-imap")!.click());
    expect(q<HTMLInputElement>("imap-email")!.value).toBe("ana@icloud.com");
    expect(q<HTMLInputElement>("imap-host")!.value).toBe("imap.mail.me.com");
  });

  it("plan 276: opened at a step (the first run coming back to it), the step neither moves in nor takes focus", async () => {
    await render(<Form way="imap" />);
    expect(q("add-account-way")!.className).not.toContain("animate-in");
    expect(document.activeElement).toBe(document.body);
    await act(async () => q("imap-back")!.click());
    expect(q("add-account-way")!.className).toContain("slide-in-from-left");
  });

  it("knows Outlook.com's domains and their country versions, and nothing else", () => {
    for (const a of ["a@outlook.com", "a@Hotmail.com", "a@live.com", "a@msn.com", "a@outlook.es", "a@hotmail.co.uk", "a@live.com.mx", " a@live.fr "]) expect(microsoftDomain(a)).not.toBeNull();
    // Codex review #5: live.fm and its like aren't Microsoft's
    for (const a of ["a@contoso.com", "a@outlook.contoso.com", "a@myhotmail.com", "a@live.example.org", "a@live.fm", "a@hotmail.xy", "a@gmail.com", "a@", "outlook.com"]) expect(microsoftDomain(a)).toBeNull();
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

  it("Codex review #4: focus on the action stays on it while the page is open and after a refusal", async () => {
    await render(<Popover open><PopoverTrigger render={<button>Open</button>} /><PopoverContent><SignInPanel accounts={[outlook({ authRequired: true } as never)]} onLater={() => {}} /></PopoverContent></Popover>);
    await act(async () => q("sign-in-microsoft")!.focus());
    await act(async () => q("sign-in-microsoft")!.click());
    expect(document.activeElement).toBe(q("sign-in-microsoft-again"));
    await settle(undefined, new RpcError("BAD_REQUEST", "Microsoft access was denied."));
    expect(document.activeElement).toBe(q("sign-in-microsoft"));
    expect(q("sign-in-error")!.textContent).toBe("Microsoft access was denied.");
  });

  it("Settings names the service Outlook, and its Reconnect signs in with Microsoft", async () => {
    expect([serviceLabel("gmail"), serviceLabel("outlook"), serviceLabel("imap")]).toEqual(["Gmail", "Outlook", "IMAP/SMTP"]);
    const account = outlook();
    setApp({ accounts: [account], owner: null, settingsAccount: account.id } as never);
    await render(<AccountsTab settings={{ syncWindowDays: 180, accountCounts: false } as never} update={async () => {}} />);
    expect(q("account-toggle")!.textContent).toContain("ana@outlook.com · Outlook · Up to date");
    const reconnect = q<HTMLButtonElement>("account-reconnect")!;
    expect(reconnect.textContent!.trim()).toBe("Sign in again with Microsoft");
    await act(async () => reconnect.click());
    expect(calls.filter((c) => c.method === "accounts.reconnect")).toEqual([expect.objectContaining({ params: { id: 7, password: undefined } })]);
  });
});

describe("the owner card (plan 259)", () => {
  it("says the Terno account was verified with Microsoft", async () => {
    const owner = { accountId: 7, email: "ana@outlook.com", displayName: "Ana", provider: "outlook", verifiedBy: "microsoft_oauth", verifiedAt: new Date(2026, 10, 24, 12).getTime(), migrated: false } as unknown as OwnerIdentity;
    const host = await render(<OwnerCard owner={owner} demo={false} accounts={[outlook()]} />);
    expect(host.textContent).toContain("Verified with Microsoft · Nov 24, 2026");
  });

  it("Codex review round 2 #5: an Outlook mailbox becomes the Terno account by signing in with Microsoft, no password asked", async () => {
    const owner = { accountId: 1, email: "luis@icloud.com", displayName: "Luis", provider: "imap", verifiedBy: "imap_login", verifiedAt: null, migrated: false } as unknown as OwnerIdentity;
    await render(<OwnerCard owner={owner} demo={false} accounts={[{ ...outlook(), id: 1, kind: "imap", email: "luis@icloud.com" } as Account, outlook()]} />);
    await act(async () => q("change-owner-open")!.click());
    expect(q("change-owner-password")).toBeNull();
    const submit = q<HTMLButtonElement>("change-owner-submit")!;
    expect(submit.textContent!.trim()).toBe("Verify with Microsoft");
    await act(async () => submit.click());
    expect(calls).toEqual([expect.objectContaining({ method: "identity.changeOwner", params: { accountId: 7, password: undefined } })]);
  });
});

describe("removing an Outlook account (plan 259)", () => {
  it("says Terno can't withdraw its access at Microsoft and links where the person can; Cancel keeps focus", async () => {
    await render(<AccountRemoveDialog account={outlook()} open onOpenChange={() => {}} from="settings" />);
    const dialog = q("account-remove-dialog")!;
    expect(dialog.textContent).toContain("Your mail in Outlook doesn’t change. Terno can’t withdraw its own access at Microsoft");
    // an organization's approval is its administrator's to withdraw (Codex review round 2 #6)
    expect(dialog.textContent).toContain("If your organization approved Terno for everyone, ask its administrator.");
    // Cancel, not the first link, has focus (Base UI would take the first tabbable)
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => q("account-remove-microsoft-personal")!.click());
    await act(async () => q("account-remove-microsoft-work")!.click());
    expect(opened).toEqual([MICROSOFT_APPS.personal, MICROSOFT_APPS.work]);
    expect(MICROSOFT_APPS).toEqual({ personal: "https://account.live.com/consent/Manage", work: "https://myapplications.microsoft.com/" });
  });
});
