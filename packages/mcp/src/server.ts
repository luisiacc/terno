import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterRuleSchema, VIEWS, type ThreadDetail, type ThreadSummary } from "@terno/core";
import { RpcError, type Bootstrap } from "@terno/core/rpc";
import { z } from "zod";
import type { AppConnection } from "./connection";

const MAX_BODY = 20_000;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message =
    error instanceof RpcError && error.code === "FORBIDDEN"
      ? "Not allowed: the user has not enabled sending for agents. Create a draft with create_draft instead and ask the user to review and send it in Única."
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createMcpServer(app: AppConnection, version = "0.1.0"): McpServer {
  const server = new McpServer(
    { name: "terno", version },
    {
      instructions:
        "Única is the user's email client: one access point to all of their connected accounts (Gmail and IMAP). " +
        "Search with Gmail-like operators (from:, to:, subject:, has:attachment, is:unread, in:inbox, account:, category:, before:, after:). " +
        "Never send email unless the user explicitly asked for it; prefer create_draft.",
    },
  );
  let boot: { at: number; data: Bootstrap } | null = null;
  const bootstrap = async () => {
    if (!boot || Date.now() - boot.at > 10_000) boot = { at: Date.now(), data: await (await app.get()).call("app.bootstrap", {}) };
    return boot.data;
  };
  const summarize = async (items: ThreadSummary[]) => {
    const b = await bootstrap();
    const accounts = new Map(b.accounts.map((a) => [a.id, a.email]));
    const categories = new Map(b.categories.map((c) => [c.id, c.name]));
    return items.map((t) => ({
      threadId: t.id,
      account: accounts.get(t.accountId),
      from: t.fromName === t.fromEmail ? t.fromEmail : `${t.fromName} <${t.fromEmail}>`,
      subject: t.subject,
      snippet: t.snippet,
      date: new Date(t.lastDate).toISOString(),
      messages: t.messageCount,
      unread: t.unread,
      starred: t.starred,
      attachments: t.hasAttachments,
      categories: t.categoryIds.map((id) => categories.get(id)).filter(Boolean),
    }));
  };
  const threadIds = z.array(z.number().int().positive()).min(1).max(500).describe("Thread ids from search_emails/list_threads");

  server.registerTool(
    "list_accounts",
    { title: "List accounts", description: "Lists connected email accounts, categories and unread counts.", annotations: { readOnlyHint: true } },
    async () => {
      try {
        const b = await bootstrap();
        return text({
          accounts: b.accounts.map((a) => ({ id: a.id, email: a.email, name: a.displayName, kind: a.kind, unreadInbox: b.counts.inboxUnreadByAccount[a.id] ?? 0, sync: a.syncState.status })),
          categories: b.categories.map((c) => ({ id: c.id, name: c.name, threads: b.counts.categoryTotal[c.id] ?? 0 })),
          unreadInbox: b.counts.inboxUnread,
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search email",
      description: "Full-text search across all accounts. Supports operators: from:, to:, subject:, has:attachment, is:unread, is:starred, in:inbox|archive|sent|trash|spam|all, account:, category:, before:YYYY-MM-DD, after:30d, \"exact phrase\", -negation.",
      inputSchema: { query: z.string().describe("Search query"), limit: z.number().int().min(1).max(100).default(25) },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        const r = await (await app.get()).call("threads.search", { query, limit });
        return text({ results: await summarize(r.items), more: r.nextCursor !== null, complete: r.complete });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "list_threads",
    {
      title: "List a mailbox view",
      description: "Lists the newest conversations in a view (inbox, starred, sent, archive, spam, trash, all), optionally for one account or category.",
      inputSchema: {
        view: z.enum(VIEWS).default("inbox"),
        accountId: z.number().int().positive().optional(),
        categoryId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const r = await (await app.get()).call("threads.list", args);
        return text({ threads: await summarize(r.items), more: r.nextCursor !== null });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_thread",
    { title: "Read a conversation", description: "Returns every message of a conversation with plain-text bodies.", inputSchema: { threadId: z.number().int().positive() }, annotations: { readOnlyHint: true } },
    async ({ threadId }) => {
      try {
        const d: ThreadDetail = await (await app.get()).call("threads.get", { threadId });
        return text({
          threadId,
          subject: d.thread.subject,
          messages: d.messages.map((m) => {
            const body = m.bodyText ?? (m.bodyHtml ? htmlToText(m.bodyHtml) : m.snippet);
            return {
              messageId: m.id,
              from: `${m.from.name} <${m.from.email}>`,
              to: m.to.map((a) => a.email),
              cc: m.cc.map((a) => a.email),
              date: new Date(m.date).toISOString(),
              sentByUser: m.isSent,
              body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…[truncated]` : body,
              attachments: m.attachments.map((a) => a.filename),
            };
          }),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "update_threads",
    {
      title: "Archive, trash, mark read…",
      description: "Applies an action to conversations: archive, trash, spam, notSpam, moveToInbox, markRead, markUnread, star, unstar. Changes sync to the mail server.",
      inputSchema: { threadIds, action: z.enum(["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"]) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        return text(await (await app.get()).call("threads.act", args));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "categorize",
    {
      title: "Add to / remove from a category",
      description: "Adds or removes conversations from a cross-account category. Pass categoryName to create the category if it doesn't exist.",
      inputSchema: {
        threadIds,
        categoryId: z.number().int().positive().optional(),
        categoryName: z.string().min(1).max(60).optional(),
        remove: z.boolean().default(false),
      },
    },
    async ({ threadIds, categoryId, categoryName, remove }) => {
      try {
        const client = await app.get();
        let id = categoryId;
        if (!id && categoryName) {
          const b = await bootstrap();
          id = b.categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase())?.id;
          if (!id && !remove) {
            id = (await client.call("categories.create", { name: categoryName, color: "indigo" })).id;
            boot = null;
          }
        }
        if (!id) return failure(new Error("Unknown category. Pass categoryId or categoryName."));
        return text(remove ? await client.call("categories.removeThreads", { categoryId: id, threadIds }) : await client.call("categories.addThreads", { categoryId: id, threadIds }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  const address = z.object({ name: z.string().default(""), email: z.string().email() });
  const compose = {
    accountId: z.number().int().positive().describe("Account to send from (list_accounts)"),
    to: z.array(address).min(1),
    cc: z.array(address).default([]),
    subject: z.string(),
    body: z.string().describe("Plain text body"),
    inReplyToMessageId: z.number().int().positive().optional().describe("messageId from get_thread when replying"),
  };

  server.registerTool(
    "create_draft",
    { title: "Create a draft", description: "Saves a draft in Única for the user to review and send.", inputSchema: compose },
    async (a) => {
      try {
        const d = await (await app.get()).call("drafts.save", { accountId: a.accountId, to: a.to, cc: a.cc, subject: a.subject, bodyText: a.body, inReplyToMessageId: a.inReplyToMessageId });
        // a new draft (no id given) is always saved
        return text({ draftId: d!.id, note: "Draft saved. The user can review it in Única." });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description: "Sends an email immediately. Only works if the user enabled 'Allow agents to send' in Única. Only use when the user explicitly asked to send.",
      inputSchema: compose,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await (await app.get()).call("compose.send", { accountId: a.accountId, to: a.to, cc: a.cc, bcc: [], subject: a.subject, bodyText: a.body, inReplyToMessageId: a.inReplyToMessageId });
        return text({ queued: true, ...r });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "list_filters",
    { title: "List filters", description: "Lists the user's mail filters.", annotations: { readOnlyHint: true } },
    async () => {
      try {
        return text(await (await app.get()).call("filters.list", {}));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "create_filter",
    {
      title: "Create a filter",
      description:
        "Creates a filter for incoming mail. rule = { match: 'all'|'any', conditions: [{ field: from|fromDomain|recipients|subject|body|listId, op: contains|equals|startsWith|endsWith, value, negate? } | { field: 'hasAttachment', op: 'is', value: boolean } | { field: 'ageDays', op: 'gt'|'lt', value: number }], actions: [{ type: archive|trash|spam|markRead|star } | { type: 'addCategory', categoryId }] }. Set dryRun to preview matches without saving.",
      inputSchema: { name: z.string().min(1).max(120), rule: filterRuleSchema, dryRun: z.boolean().default(false) },
    },
    async ({ name, rule, dryRun }) => {
      try {
        const client = await app.get();
        const preview = await client.call("filters.preview", { rule, limit: 5 });
        if (dryRun) return text({ wouldMatch: preview.count, sample: await summarize(preview.sample) });
        const f = await client.call("filters.save", { name, enabled: true, source: "ai", rule });
        return text({ filterId: f.id, matchesExisting: preview.count, note: "Applies to new mail. The user can apply it to existing mail from Única." });
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
