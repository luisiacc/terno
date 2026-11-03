/**
 * Plan 125: withdraw Terno's Google grant when its account is removed. Revoking ends the user's authorization for
 * every client in the Cloud project (desktop dev and prod, the web), so every token it issued stops working. The token
 * goes in the form body, never the URL (URLs reach logs), and never follows a redirect. Only a 200 confirms: Google's
 * `invalid_token` means expired *or* revoked, which doesn't prove another valid grant is gone. Best effort: the caller
 * has removed the account whatever happens here. The endpoint has no CORS, so a browser can't use this (plan 125 §2).
 */
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

export type GoogleRevokeOutcome = "revoked" | "failed";

export async function revokeGoogleToken(token: string, netFetch: typeof fetch, signal?: AbortSignal): Promise<GoogleRevokeOutcome> {
  try {
    signal?.throwIfAborted();
    // a fetch that ignores its signal still can't hold the caller past it
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const response = await Promise.race([
      netFetch(GOOGLE_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        redirect: "error",
        signal,
      }),
      aborted,
    ]);
    // the status says it all: the body is never read
    void response.body?.cancel().catch(() => {});
    return response.status === 200 ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}
