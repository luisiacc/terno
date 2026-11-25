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

const { AddAccountForm, EMPTY_ACCOUNT_DRAFT } = await import("./add-account-dialog");
const { setApp } = await import("~/state/app");

function Form() {
  const [draft, setDraft] = useState({ ...EMPTY_ACCOUNT_DRAFT, form: { ...EMPTY_ACCOUNT_DRAFT.form, email: "ana@outlook.com" } });
  return <AddAccountForm draft={draft} onDraft={setDraft} onDone={() => {}} />;
}

it("the web's Add account offers Google alone, and no Microsoft hint", async () => {
  setLocale("en", en);
  // a host that could take IMAP, so the form (and where its hint would be) is drawn
  setApp({ host: { kind: "web", capabilities: { imap: true, agents: false, backgroundSync: false, network: "any" } } } as never);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    expect(host.querySelector("[data-testid=connect-gmail]")).not.toBeNull();
    expect(host.querySelector("[data-testid=connect-microsoft]")).toBeNull();
    expect(host.querySelector("[data-testid=imap-email]")).not.toBeNull();
    expect(host.querySelector("[data-testid=imap-microsoft-hint]")).toBeNull();
    expect(host.textContent).not.toContain("Microsoft");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
