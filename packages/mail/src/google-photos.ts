/**
 * Google photos for sender avatars (plan 22): the account's own picture
 * (OpenID userinfo, scope `profile`) and the photos of the user's contacts and
 * "other contacts" (People API, scopes `contacts.readonly` and
 * `contacts.other.readonly`, each granted on its own). Google's generated
 * letter avatars (`default: true`) are skipped. Nothing here is logged.
 */
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
export const OTHER_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";
export const PEOPLE_API = "https://people.googleapis.com/v1";

/** What happened to one source: read, not granted, the project's People API off, or not asked. */
export type PhotoSourceState = "ok" | "denied" | "disabled" | "skipped" | "failed";

export interface GooglePhotos {
  own: string | null;
  contacts: { email: string; url: string }[];
  connections: PhotoSourceState;
  otherContacts: PhotoSourceState;
}

export interface PhotoWant {
  connections: boolean;
  otherContacts: boolean;
}

interface Person {
  emailAddresses?: { value?: string }[];
  photos?: { url?: string; default?: boolean; metadata?: { primary?: boolean } }[];
}

/** The authorized GET the provider already has (token refresh, deadlines, network classification). */
export type AuthorizedGet = <T>(url: string) => Promise<T>;

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
/** at most this many addresses per account */
export const MAX_PHOTO_CONTACTS = 20_000;

/** The photo at 128 px (Google's size suffix), https on Google's image hosts only. */
export function photoUrl(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/(^|\.)(googleusercontent\.com|ggpht\.com)$/.test(u.hostname)) return null;
  u.pathname = u.pathname.replace(/=s\d+(-[a-z0-9-]+)?$/i, "");
  u.search = "";
  u.hash = "";
  return `${u.toString()}=s128`;
}

function classify(error: unknown): PhotoSourceState {
  const status = (error as { status?: number }).status;
  const text = error instanceof Error ? error.message : String(error);
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) return "disabled";
  if (status === 403 && /SCOPE_INSUFFICIENT|insufficient/i.test(text)) return "denied";
  if (status === 403) return "denied";
  return "failed";
}

async function pages(get: AuthorizedGet, path: string, mask: string, out: Map<string, string>): Promise<void> {
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES && out.size < MAX_PHOTO_CONTACTS; page++) {
    const q = new URLSearchParams({ [mask]: "emailAddresses,photos", pageSize: String(PAGE_SIZE) });
    if (token) q.set("pageToken", token);
    const res = await get<{ connections?: Person[]; otherContacts?: Person[]; nextPageToken?: string }>(`${PEOPLE_API}/${path}?${q}`);
    for (const p of res.connections ?? res.otherContacts ?? []) {
      const photos = (p.photos ?? []).filter((ph) => !ph.default);
      const url = photoUrl((photos.find((ph) => ph.metadata?.primary) ?? photos[0])?.url);
      if (!url) continue;
      for (const e of p.emailAddresses ?? []) {
        const email = e.value?.trim().toLowerCase();
        if (email && email.includes("@") && !out.has(email) && out.size < MAX_PHOTO_CONTACTS) out.set(email, url);
      }
    }
    token = res.nextPageToken;
    if (!token) break;
  }
}

/** Both sources, as far as each is granted; one failing keeps the other's photos. */
export async function collectGooglePhotos(get: AuthorizedGet, userinfo: string, want: PhotoWant): Promise<GooglePhotos> {
  const own = await get<{ picture?: string }>(userinfo).then((i) => photoUrl(i.picture), () => null);
  const found = new Map<string, string>();
  const source = async (wanted: boolean, path: string, mask: string): Promise<PhotoSourceState> => {
    if (!wanted) return "skipped";
    try {
      await pages(get, path, mask, found);
      return "ok";
    } catch (error) {
      return classify(error);
    }
  };
  // "people/me/connections" are the user's contacts; "otherContacts", people they've written to or heard from
  const connections = await source(want.connections, "people/me/connections", "personFields");
  const otherContacts = await source(want.otherContacts, "otherContacts", "readMask");
  return { own, contacts: [...found].map(([email, url]) => ({ email, url })), connections, otherContacts };
}
