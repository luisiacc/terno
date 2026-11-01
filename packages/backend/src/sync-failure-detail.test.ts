import { googleReasonOf } from "@terno/mail";
import { ProviderCooldownError, ProviderError } from "@terno/mail/portable";
import { describe, expect, it } from "vitest";
import { requestShape, syncFailureDetail } from "./core";

// What the console adds to "sync failed": enough to tell a quota 403 from a permission one, never mail content.
describe("sync failure detail", () => {
  it("names Google's reason, the status and the request shape (ids replaced)", () => {
    const body = JSON.stringify({ error: { code: 403, message: "secret-free text that is never logged", errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }] } });
    expect(googleReasonOf(body)).toBe("rateLimitExceeded");
    expect(googleReasonOf("<html>")).toBeUndefined();
    expect(googleReasonOf(JSON.stringify({ error: { errors: [{ reason: "has spaces <script>" }] } }))).toBeUndefined();
    const error = Object.assign(new ProviderError("Gmail couldn’t complete the request (403).", true), { status: 403, googleReason: "rateLimitExceeded", resource: "/messages/18c2f9a0b1d2e3f4?format=raw" });
    expect(syncFailureDetail(error)).toBe(" [HTTP 403, rateLimitExceeded, /messages/:id]");
  });

  it("says why a pause holds", () => {
    expect(syncFailureDetail(new ProviderCooldownError("gmail-api", "4", "clock"))).toBe(" [paused: gmail-api, clock]");
    expect(syncFailureDetail(new Error("x"))).toBe("");
  });

  it("keeps only route words: every id goes, whatever it looks like (Codex review)", () => {
    expect(requestShape("/messages/abcdefabcdefabcd?format=raw")).toBe("/messages/:id");
    expect(requestShape("/messages/x/attachments/ANGjdJ8%2Fq")).toBe("/messages/:id/attachments/:id");
    expect(requestShape("/threads/18c2?format=metadata")).toBe("/threads/:id");
    expect(requestShape("https://people.googleapis.com/v1/people/me/connections?personFields=names")).toBe("/v1/people/me/connections");
    expect(requestShape("/labels/Label_12/../ana@example.com")).toBe("/labels/:id/:id/:id");
  });
});
