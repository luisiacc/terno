---
name: terno
description: Read, search, triage and organize the user's email across all their accounts through the Terno email client (MCP server "terno"). Use when the user asks about their email, inbox, newsletters, receipts, replies to write, or mail filters.
---

# Terno: email for agents

Terno is the user's local email client. Its MCP server (`terno`) gives you one access point to **every connected account** (Gmail and IMAP). The Terno app must be running.

## Tools
- `list_accounts`: accounts, categories, unread counts. Call this first to learn account ids.
- `search_emails`: full-text search across all accounts (fast, local).
- `list_threads`: newest conversations of a view (`inbox`, `starred`, `sent`, `archive`, `spam`, `trash`, `all`).
- `get_thread`: read a whole conversation as plain text.
- `update_threads`: `archive`, `trash`, `spam`, `markRead`, `star`… (syncs to the server).
- `categorize`: add/remove conversations to cross-account categories (creates the category by name).
- `create_draft`: save a reply or new email for the user to review.
- `send_email`: send immediately. **Only when the user explicitly asked to send**, and only works if they enabled it in Terno → Ajustes → Agentes.
- `list_filters` / `create_filter`: inspect or create mail filters (use `dryRun: true` first and report how many emails it would match).

## Search syntax
`from:ana subject:"factura marzo" has:attachment is:unread in:inbox account:work category:Facturas before:2026-01-01 after:30d -newsletter`
Spanish aliases work too (`de:`, `para:`, `asunto:`, `tiene:adjunto`, `es:noleido`, `en:papelera`).

## Etiquette
- Summaries: lead with what needs action; group by account only if it helps.
- Before bulk actions (archiving/trashing many threads) show the user what will change and confirm.
- Prefer `create_draft` over `send_email`. Never invent recipients.
- Quote thread ids only when you need them for follow-up tool calls; the user cares about senders and subjects.
