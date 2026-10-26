import { describe, expect, it } from "vitest";
import { collectGooglePhotos, PEOPLE_API, photoUrl, type AuthorizedGet } from "./google-photos";

const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const err = (status: number, body: string) => Object.assign(new Error(`Gmail API ${status}: ${body}`), { status });

/** A mocked People API: pages per source, or an error. */
function people(o: { connections?: unknown[][] | Error; other?: unknown[][] | Error; picture?: string }) {
  const calls: string[] = [];
  const get: AuthorizedGet = async <T,>(url: string): Promise<T> => {
    calls.push(url);
    if (url === USERINFO) return { picture: o.picture } as T;
    const u = new URL(url);
    const page = Number(u.searchParams.get("pageToken") ?? 0);
    const source = u.pathname.endsWith("/connections") ? o.connections : o.other;
    if (source instanceof Error) throw source;
    const pages = source ?? [[]];
    const key = u.pathname.endsWith("/connections") ? "connections" : "otherContacts";
    return { [key]: pages[page], nextPageToken: page + 1 < pages.length ? String(page + 1) : undefined } as T;
  };
  return { get, calls };
}

const person = (emails: string[], photos: { url: string; default?: boolean; primary?: boolean }[]) => ({
  emailAddresses: emails.map((value) => ({ value })),
  photos: photos.map((p) => ({ url: p.url, default: p.default, metadata: { primary: p.primary } })),
});
const PHOTO = "https://lh3.googleusercontent.com/a-/ALV-UjXabc=s100";

describe("Google photos (plan 22)", () => {
  it("contacts and other contacts, every page, matched by address; Google's letter avatars skipped; the photo at 128 px", async () => {
    const { get, calls } = people({
      picture: "https://lh3.googleusercontent.com/a/own=s96-c",
      connections: [[person(["Ana@Example.com", "ana.work@acme.studio"], [{ url: PHOTO, primary: true }])], [person(["bob@example.com"], [{ url: "https://lh3.googleusercontent.com/x=s100", default: true }])]],
      other: [[person(["carla@example.org"], [{ url: "https://lh5.googleusercontent.com/c=s100" }])]],
    });
    const r = await collectGooglePhotos(get, USERINFO, { connections: true, otherContacts: true });
    expect(r.own).toBe("https://lh3.googleusercontent.com/a/own=s128");
    expect(r.contacts).toEqual([
      { email: "ana@example.com", url: "https://lh3.googleusercontent.com/a-/ALV-UjXabc=s128" },
      { email: "ana.work@acme.studio", url: "https://lh3.googleusercontent.com/a-/ALV-UjXabc=s128" },
      { email: "carla@example.org", url: "https://lh5.googleusercontent.com/c=s128" },
    ]);
    expect(r).toMatchObject({ connections: "ok", otherContacts: "ok" });
    expect(calls.filter((c) => c.startsWith(`${PEOPLE_API}/people/me/connections`))).toHaveLength(2);
    expect(calls.find((c) => c.includes("/otherContacts"))).toContain("readMask=emailAddresses%2Cphotos");
  });

  it("asks only for what was granted, and keeps one source's photos when the other is refused", async () => {
    const only = people({ connections: [[person(["a@x.com"], [{ url: PHOTO }])]] });
    const r = await collectGooglePhotos(only.get, USERINFO, { connections: true, otherContacts: false });
    expect(r.otherContacts).toBe("skipped");
    expect(only.calls.some((c) => c.includes("otherContacts"))).toBe(false);

    const denied = people({ connections: err(403, `{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}`), other: [[person(["b@y.com"], [{ url: PHOTO }])]] });
    const d = await collectGooglePhotos(denied.get, USERINFO, { connections: true, otherContacts: true });
    expect(d).toMatchObject({ connections: "denied", otherContacts: "ok", contacts: [{ email: "b@y.com" }] });
  });

  it("the People API turned off in the project is told apart (Settings says how to turn it on)", async () => {
    const off = err(403, `{"error":{"code":403,"message":"People API has not been used in project 123 before or it is disabled.","status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}`);
    const r = await collectGooglePhotos(people({ connections: off, other: off }).get, USERINFO, { connections: true, otherContacts: true });
    expect(r).toMatchObject({ connections: "disabled", otherContacts: "disabled", contacts: [] });
    const failed = await collectGooglePhotos(people({ connections: err(500, "boom") }).get, USERINFO, { connections: true, otherContacts: false });
    expect(failed.connections).toBe("failed");
  });

  it("cancelled mid-list: not one more page, and every request carried the signal (Codex review)", async () => {
    const ctl = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const { get, calls } = people({ connections: [[person(["a@x.com"], [{ url: PHOTO }])], [person(["b@x.com"], [{ url: PHOTO }])], [person(["c@x.com"], [{ url: PHOTO }])]] });
    const watching: AuthorizedGet = async <T,>(url: string, signal?: AbortSignal) => {
      seen.push(signal);
      const r = await get<T>(url, signal);
      if (url.includes("/connections")) ctl.abort();
      return r;
    };
    await expect(collectGooglePhotos(watching, USERINFO, { connections: true, otherContacts: true }, ctl.signal)).rejects.toThrow();
    expect(calls.filter((c) => c.includes("/connections"))).toHaveLength(1);
    expect(calls.some((c) => c.includes("otherContacts"))).toBe(false);
    expect(seen.every((s) => s === ctl.signal)).toBe(true);
  });

  it("photo URLs only from Google's image hosts, https", () => {
    expect(photoUrl("https://lh3.googleusercontent.com/a/b=s100-c")).toBe("https://lh3.googleusercontent.com/a/b=s128");
    expect(photoUrl("https://yt3.ggpht.com/x")).toBe("https://yt3.ggpht.com/x=s128");
    expect(photoUrl("http://lh3.googleusercontent.com/a")).toBeNull();
    expect(photoUrl("https://googleusercontent.com.evil.example/a")).toBeNull();
    expect(photoUrl("https://tracker.example/p.png")).toBeNull();
    expect(photoUrl(undefined)).toBeNull();
  });
});
