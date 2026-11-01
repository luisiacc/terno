// @vitest-environment jsdom
/**
 * Plan 102 (Codex code review round 3 #2): Sign in again… from the account menu opens the key's panel once its
 * chunk is in, but not over what the user moved on to while it loaded.
 */
import type { Account } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => {
  let open!: () => void;
  const ready = new Promise<void>((r) => (open = r));
  return { ready, open: () => open() };
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}), on: () => () => {} } }));
// the panel's chunk, held until the test lets it in
vi.mock("./sign-in-panel", async () => {
  await gate.ready;
  return { default: () => <p data-testid="panel">panel</p> };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SignInMarker, openSignInMarker } = await import("./sign-in-notice");

const account = { id: 3, kind: "imap", email: "a@example.com", displayName: "A", color: "indigo", syncState: { status: "error", authRequired: true } } as unknown as Account;

beforeEach(() => {
  setLocale("en", en);
  document.body.innerHTML = "";
});

function mount() {
  const host = document.createElement("div");
  host.innerHTML = `<button data-testid="nav-account-3">A</button><input data-testid="search" />`;
  document.body.append(host);
  const root = document.createElement("div");
  host.append(root);
  act(() => createRoot(root).render(<SignInMarker account={account} />));
  return host;
}
const open = () => document.querySelector("[data-testid=sign-in-marker-3]")?.hasAttribute("data-popup-open") ?? false;

it("the user moved on while the panel loaded: it stays closed, the field keeps the focus; the next ask opens it", async () => {
  const host = mount();
  const asked = openSignInMarker(account);
  const search = host.querySelector<HTMLInputElement>("[data-testid=search]")!;
  search.focus();
  gate.open();
  await act(async () => {
    await asked;
  });
  expect(open()).toBe(false);
  expect(document.activeElement).toBe(search);

  // nothing moved this time (the menu left focus on the row): it opens
  host.querySelector<HTMLElement>("[data-testid=nav-account-3]")!.focus();
  await act(async () => {
    await openSignInMarker(account);
  });
  expect(open()).toBe(true);
});

it("asked from a menu: focus still in that closing menu opens it, another menu opened meanwhile doesn't (Codex code review round 5 #2)", async () => {
  const host = mount();
  host.insertAdjacentHTML("beforeend", `<div role="menu" id="m1"><button>Sign in again</button></div><div role="menu" id="m2"><button>Rename</button></div>`);
  const [inFirst, inSecond] = [host.querySelector<HTMLElement>("#m1 button")!, host.querySelector<HTMLElement>("#m2 button")!];
  inFirst.focus();
  let asked = openSignInMarker(account);
  inSecond.focus();
  await act(async () => {
    await asked;
  });
  expect(open()).toBe(false);

  inFirst.focus();
  asked = openSignInMarker(account);
  await act(async () => {
    await asked;
  });
  expect(open()).toBe(true);
});
