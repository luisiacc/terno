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
- `update_threads`
- `categorize`
- `create_draft`
- `send_email`: only works when the user enables it in Settings → Agents (where "Change token" also cuts off every connected agent).
- `list_filters`
- `create_filter`: supports a dry run.

[`packages/mcp/SKILL.md`](../packages/mcp/SKILL.md) teaches Claude Code the search syntax and etiquette.
