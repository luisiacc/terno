// @vitest-environment jsdom
/**
 * Plan 259 (Codex review of stage 3 #7): the web build connects no Outlook account yet (its stage 4, the owner's
 * decision): its Add account has no Microsoft way in, and an Outlook.com address typed there isn't pointed to one.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubEnv("VITE_TARGET", "web");
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {} } }));
vi.mock("~/web/google", () => ({ preloadGoogle: async () => {}, connectGmailWeb: vi.fn() }));
// the web build's own parts (vite swaps the module for the web target; the unit run doesn't)
vi.mock("~/lib/web-parts", () => ({ DesktopOnly: ({ feature }: { feature: string }) => <div data-testid={`desktop-only-${feature}`} /> }));

const { AddAccountForm, EMPTY_ACCOUNT_DRAFT } = await import("./add-account-dialog");
const { setApp } = await import("~/state/app");

function Form({ way = "choose" }: { way?: "choose" | "imap" }) {
  const [draft, setDraft] = useState({ ...EMPTY_ACCOUNT_DRAFT, way, form: { ...EMPTY_ACCOUNT_DRAFT.form, email: "ana@outlook.com" } });
  return <AddAccountForm draft={draft} onDraft={setDraft} onDone={() => {}} />;
}

async function draw(node: React.ReactNode, check: (host: HTMLElement) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(node));
    check(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

const has = (host: HTMLElement, id: string) => host.querySelector(`[data-testid=${id}]`) !== null;

it("the web's Add account offers Google and Other mail account, and no Microsoft hint", async () => {
  setLocale("en", en);
  // a host that could take IMAP, so the form (and where its hint would be) is drawn
  setApp({ host: { kind: "web", capabilities: { imap: true, agents: false, backgroundSync: false, network: "any" } } } as never);
  await draw(<Form />, (host) => {
    expect([has(host, "connect-gmail"), has(host, "connect-microsoft"), has(host, "connect-imap"), has(host, "desktop-only-imap")]).toEqual([true, false, true, false]);
  });
  await draw(<Form way="imap" />, (host) => {
    expect(has(host, "imap-email")).toBe(true);
    expect(has(host, "imap-microsoft-hint")).toBe(false);
    expect(host.textContent).not.toContain("Microsoft");
  });
});

it("plan 276: the web's worker without IMAP offers Google, and the Mac download in Other mail account's place", async () => {
  setLocale("en", en);
  setApp({ host: { kind: "web", capabilities: { imap: false, agents: false, backgroundSync: false, network: "any" } } } as never);
  // even a draft left at the IMAP step (never reached here) shows the ways in
  for (const way of ["choose", "imap"] as const) {
    await draw(<Form way={way} />, (host) => {
      expect([has(host, "connect-gmail"), has(host, "connect-imap"), has(host, "imap-email"), has(host, "desktop-only-imap")]).toEqual([true, false, false, true]);
    });
  }
});
