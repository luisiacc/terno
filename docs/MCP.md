# Agents (MCP and Skill)

Terno ships an MCP server so **Claude Code** and **Codex** get one access point to all your email.

## Setup

With Terno running:

```bash
claude mcp add terno -- /Applications/Terno.app/Contents/Resources/bin/terno-mcp
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.terno]
command = "/Applications/Terno.app/Contents/Resources/bin/terno-mcp"
```

## Tools

Available tools:

- `list_accounts`
- `search_emails`
- `list_threads`
- `get_thread`
- `get_attachment`
- `wait_for_new_mail`: waits up to 45 s for new mail in one account (a code, a reply), checking it every few seconds meanwhile (plan 191).
- `update_threads`
- `categorize`
- `create_draft`
- `send_email`: only works when the user enables it in Settings → Agents (where "Change token" also cuts off every connected agent).

Agents are allowed by default at **Read only**: `update_threads`, `categorize`, `create_draft` and `create_filter` need **Read and organize**, and `send_email` needs **Read, organize and send**, both chosen in Settings → Agents.
- `list_filters`
- `create_filter`: supports a dry run.

## How it runs (plan 293)

The MCP server runs inside Terno (its backend process). `terno-mcp` is a small native program (`apps/desktop/native/terno-mcp.c`, compiled at packaging and signed with the app) that only carries the agent's stdio to Terno's agent socket after the per-start token from the profile's 0600 token file. No Node and no Electron run for it. While Terno is closed (or agents are off), it answers `initialize` and `tools/list` itself and every tool call says to open Terno; the next call after Terno opens works.

[`packages/mcp/SKILL.md`](../packages/mcp/SKILL.md) teaches Claude Code the search syntax and etiquette.
