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
import { setGooglePhotoState } from "../settings";

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
      return { email: o.loginHint ?? "", name: "", refreshToken: "new-token", sub: "synthetic-photo-subject", emailVerified: true, grantedScopes: [MAIL, CONTACTS], ...f.connect };
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

  it("desktop photo consent replaces the provider and keeps push sync working", async () => {
    const { backend, client, gmail, f } = await setup();
    const create = backend.options.providers.create.bind(backend.options.providers);
    const runs = [vi.fn(async () => {}), vi.fn(async () => {})];
    const stops = [vi.fn(), vi.fn()];
    const pushes: (() => void)[] = [];
    let made = 0;
    vi.spyOn(backend.options.providers, "create").mockImplementation((ctx) => {
      const index = made++;
      return { ...create(ctx), sync: runs[index]!, watch(push) { pushes[index] = push; return stops[index]!; } };
    });
    backend.startAccount(gmail);
    await until(() => runs[0]!.mock.calls.length === 1 && pushes.length === 1);
    await backend.syncAccount(gmail.id);
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    expect(made).toBe(2);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(f.photoWants).toEqual([{ connections: true, otherContacts: false }]);
    await until(() => runs[1]!.mock.calls.length === 1 && pushes.length === 2);
    await backend.syncAccount(gmail.id);
    const synced = runs[1]!.mock.calls.length;
    pushes[1]!();
    await until(() => runs[1]!.mock.calls.length === synced + 1);
    const fresh = await backend.provider(gmail.id);
    expect(fresh).not.toBeNull();
    expect((await backend.store.accounts.get(gmail.id))?.syncState.authRequired).toBe(false);
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
    await setGooglePhotoState(backend.store, gmail.id, { connections: true, otherContacts: true, apiDisabled: false });
    const running = backend.icons.syncPeople(gmail.id, { connections: true, otherContacts: true, apiDisabled: false });
    await until(() => signal !== undefined);
    await backend.icons.dropPhotos(gmail.id);
    expect(signal!.aborted).toBe(true);
    await running;
    expect(backend.icons.photoCount(gmail.id)).toBe(0);
  });

  it("turning photos off while a listing is still starting: it never reaches Google (second Codex review)", async () => {
    const { backend, gmail } = await setup();
    const provider = (await backend.provider(gmail.id))!;
    let asked = 0;
    provider.photos = async () => {
      asked++;
      return { own: null, contacts: [], connections: "ok", otherContacts: "ok" };
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const original = backend.provider.bind(backend);
    backend.provider = async (id: number) => {
      await held;
      return original(id);
    };
    await setGooglePhotoState(backend.store, gmail.id, { connections: true, otherContacts: true, apiDisabled: false });
    const running = backend.icons.syncPeople(gmail.id, { connections: true, otherContacts: true, apiDisabled: false });
    await new Promise((r) => setTimeout(r, 20));
    await backend.icons.dropPhotos(gmail.id);
    release();
    await running;
    expect(asked).toBe(0);
  });

  it("photo URLs are kept only while their fetch is pending (second Codex review)", async () => {
    const { client, gmail, events, backend } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    await client.call("icons.lookup", { emails: ["ana@gmail.com", gmail.email] });
    await until(() => Object.keys(Object.assign({}, ...events.map((e) => e.icons))).length >= 2);
    await until(() => backend.icons.pendingPhotoUrls === 0);
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: false });
    expect(backend.icons.pendingPhotoUrls).toBe(0);
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
    await setGooglePhotoState(backend.store, gmail.id, state);
    await backend.icons.syncPeople(gmail.id, state);
    expect(backend.icons.photoCount(gmail.id)).toBe(15_000);
    await backend.icons.syncPeople(gmail.id, state);
    await backend.icons.syncPeople(gmail.id, state);
    expect(backend.icons.photoCount(gmail.id)).toBe(20_000);
  });

  it("removing the account drops its photo state", async () => {
    const { client, gmail } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true });
    await client.call("accounts.remove", { id: gmail.id });
    expect((await client.call("app.bootstrap", {})).settings.googlePhotos).toEqual({});
  });
});

describe("photos from Google, on without signing in now (plan 71)", () => {
  it("turning on with `later` asks Google nothing and fetches nothing: the account waits for its next sign-in", async () => {
    const { client, f, gmail, fetchSpy } = await setup();
    const settings = await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    expect(settings.googlePhotosPending).toEqual([gmail.id]);
    expect(settings.googlePhotos[String(gmail.id)]).toBeUndefined();
    expect(f.connectCalls).toEqual([]);
    expect(f.photoWants).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the next sign-in asks for the contacts scopes too; what Google grants turns photos on and ends the wait", async () => {
    const { client, f, gmail } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await client.call("accounts.reconnect", { id: gmail.id });
    expect(f.connectCalls).toEqual([{ loginHint: gmail.email, scopes: expect.arrayContaining([MAIL, CONTACTS, OTHER]) }]);
    const settings = await client.call("settings.update", {});
    expect(settings.googlePhotos[String(gmail.id)]).toEqual({ connections: true, otherContacts: false, apiDisabled: false });
    expect(settings.googlePhotosPending).toEqual([]);
  });

  it("unticked on Google's screen: mail signs in, photos stay off and stop waiting", async () => {
    const { client, f, gmail } = await setup();
    f.connect = { grantedScopes: [MAIL] };
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await client.call("accounts.reconnect", { id: gmail.id });
    const settings = await client.call("settings.update", {});
    expect(settings.googlePhotos[String(gmail.id)]).toBeUndefined();
    expect(settings.googlePhotosPending).toEqual([]);
  });

  it("an account that isn't waiting signs in with mail's scopes only", async () => {
    const { client, f, gmail } = await setup();
    await client.call("accounts.reconnect", { id: gmail.id });
    expect(f.connectCalls).toHaveLength(1);
    expect(f.connectCalls[0]!.scopes).toBeUndefined();
  });

  it("off while waiting clears it; removing the account clears it", async () => {
    const { client, gmail, backend } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    expect((await client.call("icons.googlePhotos", { accountId: gmail.id, on: false })).googlePhotosPending).toEqual([]);
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await client.call("accounts.remove", { id: gmail.id });
    expect((await client.call("settings.update", {})).googlePhotosPending).toEqual([]);
    expect(await backend.store.accounts.get(gmail.id)).toBeNull();
  });

  it("the icon service's own updates don't end the wait", async () => {
    const { client, gmail, backend } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await setGooglePhotoState(backend.store, gmail.id + 999, { connections: true, otherContacts: false, apiDisabled: true }, false);
    await setGooglePhotoState(backend.store, gmail.id, null, false);
    expect((await client.call("settings.update", {})).googlePhotosPending).toEqual([gmail.id]);
  });

  it("an IMAP account can't wait for Google", async () => {
    const { client, backend } = await setup();
    const imap = (await backend.store.accounts.list()).find((a) => a.kind !== "gmail");
    if (!imap) return;
    expect((await errorOf(client.call("icons.googlePhotos", { accountId: imap.id, on: true, later: true })))?.code).toBe("BAD_REQUEST");
  });
});

// Codex review round 1 (plan 71)
describe("photos waiting for a sign-in: races (plan 71)", () => {
  it("web: a sign-in's consent arriving after the switch went off turns nothing on", async () => {
    const { client, f, gmail } = await setup({ web: true });
    f.inspectEmail = gmail.email;
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: false });
    const s = await client.call("icons.authorizeGoogle", { accountId: gmail.id, accessToken: "t", expiresIn: 3600, scope: `${MAIL} ${CONTACTS}`, ifPending: true });
    expect(s.googlePhotos[String(gmail.id)]).toBeUndefined();
    expect(f.photoWants).toEqual([]);
  });

  it("switching a waiting account off doesn't cancel its reconnect under way: mail signs in, photos stay off", async () => {
    const { backend, client, f, gmail } = await setup();
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const connect = backend.options.providers.connectGmail.bind(backend.options.providers);
    vi.spyOn(backend.options.providers, "connectGmail").mockImplementation(async (o) => {
      await held;
      return connect(o);
    });
    const reconnect = client.call("accounts.reconnect", { id: gmail.id });
    await until(() => backend.signIns.has(gmail.id));
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: false });
    release();
    await expect(reconnect).resolves.toMatchObject({ id: gmail.id });
    const s = await client.call("settings.update", {});
    expect(s.googlePhotos[String(gmail.id)]).toBeUndefined();
    expect(s.googlePhotosPending).toEqual([]);
    expect(f.photoWants).toEqual([]);
  });

  it("the reconnect answers after the people are listed: a People API that's off shows at once", async () => {
    const { client, f, gmail } = await setup();
    f.photos = { contacts: [], connections: "disabled" };
    await client.call("icons.googlePhotos", { accountId: gmail.id, on: true, later: true });
    await client.call("accounts.reconnect", { id: gmail.id });
    expect((await client.call("settings.update", {})).googlePhotos[String(gmail.id)]).toMatchObject({ apiDisabled: true });
  });
});
