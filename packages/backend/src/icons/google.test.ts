/** Plan 22: photos from Google, turned on per Gmail account with the People API mocked. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, type IconAnswer, type IconRef, type RpcError } from "@terno/core/rpc";
import { createDemoProvider, demoRegistry, type GmailConnectResult, type GooglePhotos, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pngBytes } from "../test/icons-fixtures";
import { Backend, plaintextCipher } from "../backend";
import { seedDemo } from "../demo";

const MAIL = "https://www.googleapis.com/auth/gmail.modify";
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
const OTHER = "https://www.googleapis.com/auth/contacts.other.readonly";
const ANA = "https://lh3.googleusercontent.com/a/ana=s128";
const OWN = "https://lh3.googleusercontent.com/a/own=s128";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Fake {
  connect: Partial<GmailConnectResult> & { email?: string };
  photos: Partial<GooglePhotos>;
  connectCalls: { scopes?: string[]; loginHint?: string }[];
  photoWants: unknown[];
  tokens: Map<number, string>;
  inspectEmail: string;
}

function registry(f: Fake, web = false): ProviderRegistry {
  return {
    ...demoRegistry,
    gmailTokens: web
      ? {
          inspect: async () => ({ email: f.inspectEmail, name: "", sub: null, emailVerified: true }),
          set: (id, token) => void f.tokens.set(id, token),
        }
      : undefined,
    create(ctx) {
      return {
        ...createDemoProvider(ctx),
        async photos(want) {
          f.photoWants.push(want);
          return { own: OWN, contacts: [{ email: "ana@gmail.com", url: ANA }, { email: "lead@acme.studio", url: ANA }], connections: "ok", otherContacts: want.otherContacts ? "ok" : "skipped", ...f.photos };
        },
      };
    },
    async connectGmail(o) {
      f.connectCalls.push({ scopes: o.scopes, loginHint: o.loginHint });
      return { email: o.loginHint ?? "", name: "", refreshToken: "new-token", sub: null, emailVerified: true, grantedScopes: [MAIL, CONTACTS], ...f.connect };
    },
  };
}

async function setup(o: { web?: boolean } = {}) {
  const f: Fake = { connect: {}, photos: {}, connectCalls: [], photoWants: [], tokens: new Map(), inspectEmail: "" };
  // Google's image host answers with a photo; anything else would be a bug
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://lh3.googleusercontent.com/")) throw new Error(`unexpected request to ${url}`);
    return new Response(Buffer.from(pngBytes(128)), { status: 200, headers: { "content-type": "image/png" } });
  });
  const dir = mkdtempSync(join(tmpdir(), "terno-gphotos-"));
  const backend = new Backend({ dbPath: join(dir, "g.db"), version: "t", cipher: plaintextCipher, providers: registry(f, o.web), autoSync: false, iconTransport: null, openExternal: async () => {} });
  await seedDemo(backend.store, { threads: 60, accounts: 2 });
  await backend.store.settings.update<Record<string, unknown>, void>("app", {}, (s) => ({ value: { ...s, gmailClientId: "client.apps.googleusercontent.com" }, result: undefined }));
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const events: { icons: Record<string, IconAnswer>; reset?: boolean }[] = [];
  client.on("icons", (e) => events.push(e));
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const gmail = (await backend.store.accounts.list()).find((a) => a.kind === "gmail")!;
  return { backend, client, f, events, gmail, fetchSpy };
}

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);
async function until(f: () => boolean) {
  for (const end = Date.now() + 3000; !f(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("timed out");
}

describe("photos from Google (plan 22)", () => {
  it("desktop: consent asks for mail's scopes and both contact scopes, for that account; the new grant replaces the old; photos show by address", async () => {
    const { backend, client, f, events, gmail } = await setup();
    const before = await backend.getSecret(`account:${gmail.id}:refreshToken`);
    const settings = await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    expect(f.connectCalls).toEqual([{ loginHint: gmail.email, scopes: expect.arrayContaining([MAIL, CONTACTS, OTHER, "openid", "email", "profile"]) }]);
    expect(settings.googlePhotos[String(gmail.id)]).toEqual({ connections: true, otherContacts: false, apiDisabled: false });
    // only the granted source is read
    expect(f.photoWants).toEqual([{ connections: true, otherContacts: false }]);
    expect(await backend.getSecret(`account:${gmail.id}:refreshToken`)).toBe("new-token");
    expect(before).not.toBe("new-token");
    // a contact's photo wins over initials (freemail) and over a website icon (company domain); the account's own picture answers for it
    const first = await client.call("icons.lookup", { emails: ["ana@gmail.com", "Lead@Acme.Studio", gmail.email, "nobody@gmail.com"] });
    expect(first["nobody@gmail.com"]).toBeNull();
    await until(() => Object.keys(Object.assign({}, ...events.map((e) => e.icons))).length >= 3);
    const got = Object.assign({}, ...events.map((e) => e.icons)) as Record<string, IconRef>;
    expect(got["ana@gmail.com"]).toMatchObject({ kind: "photo", full: true, px: 128 });
    expect(got["Lead@Acme.Studio"]!.id).toBe(got["ana@gmail.com"]!.id);
    expect(got[gmail.email]).toMatchObject({ kind: "photo" });
    expect(got[gmail.email]!.id).not.toBe(got["ana@gmail.com"]!.id);
    expect((await client.call("icons.data", { ids: [got["ana@gmail.com"]!.id] }))[got["ana@gmail.com"]!.id]).toMatch(/^data:image\/png;base64,/);
  });

  it("nothing changes when Google connected another account, or dropped mail's scope", async () => {
    const { backend, client, f, gmail } = await setup();
    const before = await backend.getSecret(`account:${gmail.id}:refreshToken`);
    f.connect = { email: "someone.else@gmail.com" };
    expect(await errorOf(client.call("icons.googlePhotos", { accountId: gmail.id, on: true }))).toMatchObject({ code: "BAD_REQUEST" });
    f.connect = { grantedScopes: [CONTACTS, OTHER] };
    expect(await errorOf(client.call("icons.googlePhotos", { accountId: gmail.id, on: true }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await backend.getSecret(`account:${gmail.id}:refreshToken`)).toBe(before);
    expect((await client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });

  it("the project's People API off shows in the state; turning photos off forgets the lists and their photos", async () => {
    const { client, f, gmail, events } = await setup();
    f.photos = { contacts: [], connections: "disabled" };
    const on = await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    expect(on.googlePhotos[String(gmail.id)]).toMatchObject({ apiDisabled: true });
    f.photos = {};
    const off = await client.call("icons.googlePhotos", { accountId: gmail.id, on: false });
    expect(off.googlePhotos).toEqual({});
    expect(events.at(-1)?.reset).toBe(true);
    expect(await client.call("icons.lookup", { emails: ["ana@gmail.com"] })).toEqual({ "ana@gmail.com": null });
  });

  it("only Gmail accounts", async () => {
    const { backend, client } = await setup();
    const imap = (await backend.store.accounts.list()).find((a) => a.kind === "imap");
    if (imap) expect(await errorOf(client.call("icons.googlePhotos", { accountId: imap.id, on: true }))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("web: the page's token is refused unless it opens the same mailbox and covers mail; it never creates an account", async () => {
    const { backend, client, f, gmail } = await setup({ web: true });
    const count = (await backend.store.accounts.list()).length;
    f.inspectEmail = "other@gmail.com";
    expect(await errorOf(client.call("icons.authorizeGoogle", { accountId: gmail.id, accessToken: "t", expiresIn: 3600, scope: `${MAIL} ${CONTACTS}` }))).toMatchObject({ code: "BAD_REQUEST" });
    f.inspectEmail = gmail.email;
    expect(await errorOf(client.call("icons.authorizeGoogle", { accountId: gmail.id, accessToken: "t", expiresIn: 3600, scope: CONTACTS }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(f.tokens.size).toBe(0);
    const s = await client.call("icons.authorizeGoogle", { accountId: gmail.id, accessToken: "t2", expiresIn: 3600, scope: `openid ${MAIL} ${OTHER}` });
    expect(s.googlePhotos[String(gmail.id)]).toEqual({ connections: false, otherContacts: true, apiDisabled: false });
    expect(f.tokens.get(gmail.id)).toBe("t2");
    expect((await backend.store.accounts.list()).length).toBe(count);
    // the web asks through the page, never this method
    expect(await errorOf(client.call("icons.googlePhotos", { accountId: gmail.id, on: true }))).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("turning photos off cancels a listing in flight (Codex review)", async () => {
    const { backend, gmail } = await setup();
    let signal: AbortSignal | undefined;
    const provider = (await backend.provider(gmail.id))!;
    provider.photos = (_want, s) => {
      signal = s;
      return new Promise((_, reject) => s?.addEventListener("abort", () => reject(s.reason), { once: true }));
    };
    const running = backend.icons.syncPeople(gmail.id, { connections: true, otherContacts: true, apiDisabled: false });
    await until(() => signal !== undefined);
    await backend.icons.dropPhotos(gmail.id);
    expect(signal!.aborted).toBe(true);
    await running;
    expect(backend.icons.photoCount(gmail.id)).toBe(0);
  });

  it("partial failures in a row never keep more than the bound of addresses (Codex review)", async () => {
    const { backend, gmail } = await setup();
    const provider = (await backend.provider(gmail.id))!;
    const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${from + i}@x.com`, url: ANA }));
    let round = 0;
    provider.photos = async () => {
      round++;
      return { own: null, contacts: batch(round * 100_000, 15_000), connections: round === 1 ? "ok" : "failed", otherContacts: "ok" };
    };
    const state = { connections: true, otherContacts: true, apiDisabled: false };
    await backend.icons.syncPeople(gmail.id, state);
    await backend.icons.syncPeople(gmail.id, state);
    await backend.icons.syncPeople(gmail.id, state);
    expect(backend.icons.photoCount(gmail.id)).toBeLessThanOrEqual(20_000);
  });

  it("removing the account drops its photo state", async () => {
    const { client, gmail } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    await client.call("accounts.remove", { id: gmail.id });
    expect((await client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });
});
