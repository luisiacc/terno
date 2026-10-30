// @vitest-environment jsdom
/** Plan 71 on the web: a waiting account's sign-in, and nothing reaching Google before the user signs in. */
import type { Account } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls: { method: string; params: Record<string, unknown> }[] = [];
const ACCOUNT = { id: 5, kind: "gmail", email: "luis@gmail.com" } as Account;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "accounts.connectGmailToken") return ACCOUNT;
      return { gmailClientId: "c", googlePhotos: {}, googlePhotosPending: [] };
    }),
  },
}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let granted = "";
beforeEach(async () => {
  calls.length = 0;
  vi.stubGlobal("google", {
    accounts: {
      oauth2: {
        initTokenClient: (o: { callback: (r: object) => void }) => ({ requestAccessToken: () => o.callback({ access_token: "tok", expires_in: "3600", scope: granted }) }),
      },
    },
  });
  const { setApp } = await import("~/state/app");
  setApp({ settings: { gmailClientId: "c", googlePhotos: {}, googlePhotosPending: [ACCOUNT.id] } as unknown as AppSettings, accounts: [ACCOUNT] });
});
afterEach(() => vi.unstubAllGlobals());

const MAIL = "https://www.googleapis.com/auth/gmail.modify";
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";

// Codex review round 1 (plan 71)
it("Add account reaching a waiting mailbox: contacts declined, it stops waiting", async () => {
  granted = MAIL;
  const { connectGmailWeb } = await import("./google");
  await connectGmailWeb();
  expect(calls.map((c) => c.method)).toEqual(["accounts.connectGmailToken", "icons.googlePhotos"]);
  expect(calls[1]!.params).toEqual({ accountId: ACCOUNT.id, on: false });
});

it("a waiting account's consent counts only if it still waits (the backend reads it again)", async () => {
  granted = `${MAIL} ${CONTACTS}`;
  const { connectGmailWeb } = await import("./google");
  await connectGmailWeb(ACCOUNT.email, ACCOUNT.id);
  expect(calls.find((c) => c.method === "icons.authorizeGoogle")?.params).toMatchObject({ accountId: ACCOUNT.id, ifPending: true });
});

// Codex review round 2: Add account reaching a waiting mailbox, switched off while Google's popup is open
it("Add account: a mailbox that waited before the popup is re-checked by the backend, even if switched off meanwhile", async () => {
  granted = `${MAIL} ${CONTACTS}`;
  const { setApp, getApp } = await import("~/state/app");
  vi.stubGlobal("google", {
    accounts: {
      oauth2: {
        initTokenClient: (o: { callback: (r: object) => void }) => ({
          requestAccessToken: () => {
            // the user switches photos off in Settings while the popup is open
            setApp({ settings: { ...getApp().settings!, googlePhotosPending: [] } });
            o.callback({ access_token: "tok", expires_in: "3600", scope: granted });
          },
        }),
      },
    },
  });
  const { connectGmailWeb } = await import("./google");
  await connectGmailWeb();
  const authorize = calls.find((c) => c.method === "icons.authorizeGoogle");
  expect(authorize?.params).toMatchObject({ accountId: ACCOUNT.id, ifPending: true });
});

it("hovering or focusing Sign in now loads nothing from Google", async () => {
  vi.stubEnv("VITE_TARGET", "web");
  vi.resetModules();
  const preload = vi.fn(async () => {});
  vi.doMock("~/web/google", () => ({ preloadGoogle: preload, authorizeGooglePhotosWeb: vi.fn() }));
  const { setApp } = await import("~/state/app");
  setApp({ settings: { gmailClientId: "c", googlePhotos: {}, googlePhotosPending: [ACCOUNT.id], senderIcons: false } as unknown as AppSettings, accounts: [ACCOUNT] });
  const { SenderPictures } = await import("~/components/settings/sender-pictures");
  const { getApp } = await import("~/state/app");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SenderPictures settings={getApp().settings!} update={vi.fn()} />));
  const now = host.querySelector<HTMLButtonElement>(`[data-testid="google-photos-now-${ACCOUNT.id}"]`)!;
  expect(now).not.toBeNull();
  await act(async () => {
    now.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    now.dispatchEvent(new PointerEvent("pointerenter"));
    now.focus();
  });
  expect(preload).not.toHaveBeenCalled();
  act(() => root.unmount());
  vi.unstubAllEnvs();
});
