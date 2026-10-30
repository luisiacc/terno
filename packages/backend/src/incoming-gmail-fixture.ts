import { vi } from "vitest";

const api = new URL("https://gmail.googleapis.com/gmail/v1/users/me");

/** Private incoming qualification transport: never delegates to a real network. */
export function incomingGmailFixture(options: {
  ids: readonly string[];
  raw(id: string, token: string): Response | Promise<Response>;
  labels?: readonly string[];
  profile?(email: string): unknown;
  history?(): Response;
  observe?(url: URL, token: string): void | Promise<void>;
}) {
  const accounts = new Map<string, string>();
  const requests: { url: URL; token: string }[] = [];
  const unexpected: string[] = [];
  const refuse = (): never => { unexpected.push("Unsupported incoming fixture request"); throw new Error(unexpected.at(-1)); };
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!(input instanceof Request) || init !== undefined || input.method !== "GET" || input.redirect !== "error") return refuse();
    const url = new URL(input.url);
    const authorization = input.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return refuse();
    const token = authorization.slice(7);
    const email = accounts.get(token);
    if (!email || url.origin !== api.origin || !url.pathname.startsWith(`${api.pathname}/`)) return refuse();
    const path = url.pathname.slice(api.pathname.length);
    const keys = [...new Set(url.searchParams.keys())].sort().join(",");
    const id = path.slice("/messages/".length);
    const format = url.searchParams.get("format");
    const simple = ["/profile", "/labels"].includes(path) && keys === "";
    const list = path === "/messages" && url.searchParams.size === 3 && keys === "includeSpamTrash,maxResults,q" && url.searchParams.get("includeSpamTrash") === "true" && url.searchParams.get("maxResults") === "500" && /^after:\d+$/.test(url.searchParams.get("q") ?? "");
    const history = path === "/history" && url.searchParams.size === 6 && keys === "historyTypes,maxResults,startHistoryId" && url.searchParams.get("maxResults") === "500" && url.searchParams.getAll("historyTypes").sort().join(",") === "labelAdded,labelRemoved,messageAdded,messageDeleted" && ["10", "11"].includes(url.searchParams.get("startHistoryId") ?? "");
    const message = path.startsWith("/messages/") && options.ids.includes(id) && url.searchParams.size === 1 && keys === "format" && (format === "raw" || format === "minimal");
    if (!simple && !list && !history && !message) return refuse();
    requests.push({ url, token });
    if (options.observe) await options.observe(url, token);
    if (path === "/profile") return Response.json(options.profile ? options.profile(email) : { historyId: "10", emailAddress: email });
    if (path === "/labels") return Response.json({ labels: [] });
    if (list) return Response.json({ messages: options.ids.map((id) => ({ id })) });
    if (history) return options.history ? options.history() : Response.json({ historyId: "10" });
    if (format === "minimal") return Response.json({ id, labelIds: options.labels ?? ["INBOX"] });
    return options.raw(id, token);
  });
  return { accounts, requests, unexpected, transport };
}
