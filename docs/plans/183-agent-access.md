# Plan 183: agents are off until the user turns them on, at the level they choose

## Request (verbatim)

> i want to add the ability to connect your ai agents to it via mcp so it can read from all your inboxes

The MCP connector already existed (below). From the gaps found, the owner chose: (1) it is opt-in, off by default; (2) an access level, with read-only possible; (3) "for n3, we can have a general guide on how to add them for other agents that is short". Spam and Trash exposure and attachment access are plan 184 (another thread).

## What exists

- **The server**: `packages/mcp`, a stdio MCP server bundled as `Terno.app/Contents/Resources/bin/terno-mcp` (the app's own Node via `ELECTRON_RUN_AS_NODE`). Ten tools in `server.ts`: `list_accounts`, `search_emails`, `list_threads`, `get_thread`, `update_threads`, `categorize`, `create_draft`, `send_email`, `list_filters`, `create_filter`. It reaches the running app over `connection.ts` (reads the token file, then NDJSON RPC on the socket), reconnecting lazily.
- **The socket**: `startAgentSocket` (`packages/backend/src/agent-socket.ts`): a Unix socket and a 0600 token file in the profile; the first line must be the token; connections get `origin: "mcp"`. **It is started on every launch** by `apps/desktop/src/backend-entry.ts` (after `backend.start()`) and by `apps/backend-dev` when `agentSocket` is set. Plan 124 recorded this: "The connector always runs … Opt-in MCP … would be app changes."
- **The gate**: `BackendCore.authorize` (`core.ts`): an `mcp` connection may call only `MCP_ALLOWED`, and `compose.send` only when `allowAgentSend`. A refused call becomes `FORBIDDEN "<method> is not allowed for mcp"`. `allowAgentSend` also decides whether agents may file into a forwarding category (`agentMayFile` in `handlers.ts`, `Forwarding.agentsMaySend`).
- **Settings → Agents** (`agents-tab.tsx`): copyable setup for Claude Code and Codex, a skill install command, "Allow agents to send mail", and the token row (connected count, Change token) via `agents.status` / `agents.rotateToken`.
- **Import** (`import.ts`): a settings file can turn `allowAgentSend` off, never on.
- **The privacy page** (`apps/site/src/copy/{en,es}.ts`, section `agents`) describes the connector as always there.

## Design

### The setting

`allowAgentSend: boolean` is replaced by

```ts
agents: { enabled: boolean; access: "read" | "organize" | "send" }
```

One source of truth: enabled says whether the connector exists at all, access says what a connected agent may do. Turning agents off keeps the chosen level, so on again is one click. Default `{ enabled: false, access: "read" }`.

`AgentAccess` and its order (`AGENT_ACCESS = ["read", "organize", "send"]`) live in `packages/core` with the method table (below), so the backend and the MCP read the same thing.

**Migration** (`migrateAgents`, read-time and pure like the others, stamped `agentsVersion: 1`):
- a fresh profile: the default;
- an existing profile: `enabled: false`, `access: allowAgentSend ? "send" : "organize"` (what it could do before, ready for when the user turns it on). `allowAgentSend` is dropped.

Existing setups stop working until the user turns agents on. That is deliberate: the connector was never the user's choice (plan 124), and the agent gets a plain message saying where to turn it on (below). The owner can reverse this to "existing profiles stay on" with one line in `migrateAgents`.

### The levels

| Level | Label (en) | What an agent may do |
|---|---|---|
| `read` | Read only | list accounts, search, list, read conversations, list filters, preview a filter or a filing, see drafts |
| `organize` | Read and organize | also archive, trash, mark, star, categorize, create filters and drafts |
| `send` | Read, organize and send | also send mail, and file into a category that forwards |

The method table replaces `MCP_ALLOWED`: `AGENT_METHODS: Partial<Record<MethodName, AgentAccess>>` in `packages/core/src/agents.ts`, each allowed method with the lowest level that may call it. A method not in it is refused at every level, as today.

- read: `app.bootstrap`, `threads.list`, `threads.search`, `threads.get`, `threads.bodyPart`, `counts.get`, `filters.list`, `filters.preview`, `drafts.list`, `categorize.predict`, `categorize.suggestions`, `categorize.count`, `categorize.preview`
- organize: `threads.act`, `categories.addThreads`, `categories.removeThreads`, `categories.create`, `categorize.apply`, `filters.save`, `drafts.save`
- send: `compose.send`

`authorize` reads the level with a light read (`readAgentAccess(store)`: the stored `app` settings and the migration only, none of `readSettings`' secret and key lookups, because it now runs on every agent call). A refusal throws its own `RpcError("FORBIDDEN", …)` naming what is needed. The RPC server already awaits `authorize`, so a throw from it travels as is. The message is English, for the agent, not the UI (`i18n-ignore`, as the protocol errors are): "Terno only lets agents read. Archiving, categorizing, filters and drafts need 'Read and organize': ask the user to change it in Terno → Settings → Agents." (and the send variant, which keeps the existing advice to use `create_draft`).

`agentMayFile` and `Forwarding.agentsMaySend` read `access === "send"`.

### The connector's life

A new `AgentConnector` (`packages/backend/src/agent-connector.ts`) owns the socket; `backend-entry` and `backend-dev` stop calling `startAgentSocket` themselves. The Backend gets the paths as an option (`agentEndpoint?: { socketPath; tokenPath }`, absent on the web and in most tests) and creates the connector with them.

- `sync()`: reads `agents.enabled`; on and not running → `startAgentSocket`; off and running → `close()` (every agent cut off, the socket and the token file removed). Calls are serialized (a promise chain), so fast toggling can't leave two servers or a stale file.
- Called once after `backend.start()` (replacing the old start) and from `settings.update` when `enabled` changed, like the other settings side effects there.
- Off means nothing exists: no socket, no token file, no listener. A token file left by an older build or a crash is removed when the connector finds agents off at start, so nothing on disk suggests it's on.
- `backend.stop()` closes it, as today.

`agents.status` becomes `{ available, enabled, connected, tokenSince }`: `available` = this backend has an endpoint (desktop), `enabled` from the setting, the others from the live endpoint (0 / null when off).

### The MCP side

- Tools stay the same ten, always listed: an agent that tries to archive under "Read only" gets the backend's message and can tell the user why, instead of not knowing a tool exists. Each write tool's description ends with the level it needs ("Needs 'Read and organize' access in Terno."). The server's `instructions` say the level is the user's choice in Settings → Agents.
- `failure()` passes a `FORBIDDEN` message through as the backend wrote it (the special case for sending moves to the backend).
- `NotRunningError` can't tell "Terno isn't open" from "agents are off" (both are: no socket), so it says both: "Can't reach Terno. Open Terno and turn on Settings → Agents → Allow agents, then try again."
- `SKILL.md`: the levels in one line under Tools, and the connection message.

### Settings → Agents

Order: what it is and whether it's on, then what it may do, then how to connect.

1. **Access** group
   - **Allow agents** (switch, `agents-enabled`). Hint: "Lets AI tools on this Mac, like Claude Code, reach all your accounts while Terno is open."
   - When on: **What agents can do** (BoardUI `Select`, `agents-access`): Read only / Read and organize / Read, organize and send. The hint follows the choice and says what it allows in one sentence.
   - When on: the existing **Access token** row.
2. **Connect** group (always shown, so the user can set it up before turning it on): Claude Code and Codex as now, the skill row as now, and a new **Other apps** row:
   - hint: "Most apps that support MCP (Claude Desktop, Cursor, Windsurf…) take this in their MCP settings."
   - a `CopyBlock` with the generic config: `{ "mcpServers": { "terno": { "command": "<path>" } } }`.
   - That is the whole guide: short, one snippet that every stdio MCP client understands, no per-app pages to keep current.
   - The footer: "Your agents reach Terno only while it is open and Allow agents is on."

"Allow agents to send mail" goes (it is the third level now). New strings in `en` and `es`; the old `settings.agents.allowSend*` keys go.

### Import

A settings file can turn agents off or lower the level, never turn them on or raise it (as `allowAgentSend` before). A file from before this plan carrying `allowAgentSend: false` lowers `send` to `organize`.

### Privacy page

`apps/site` `agents` section, en and es: the connector is off until the user turns it on in Settings → Agents, where they choose whether agents may only read, also organize, or also send.

## Tests

- **Settings** (`settings-edits.test.ts` or a new `agents-settings.test.ts`): the migration (fresh → default; existing with and without `allowAgentSend` → off with `send`/`organize`; stamped once); `settings.update` of `agents`; import can lower and turn off, never raise or turn on, and an old file's `allowAgentSend: false` lowers `send`.
- **The gate** (`backend.test.ts`, replacing the `allowAgentSend` cases): for each level, a method of each tier is allowed or refused; the refusal's message names the level; an unlisted method (`settings.update`, `agents.rotateToken`) is refused even at `send`; forwarding filing needs `send` (`forwarding.test.ts` and the `agentMayFile` case).
- **The connector** (`agent-connector.test.ts`): off at start → no socket, no token file, a stale token file removed; on → socket answers the token; off → the live agent is cut, both files gone; on/off/on in quick succession → one listener, a fresh token; `agents.status` in each state.
- **MCP** (`mcp.test.ts`): the endpoint started through the setting; a write tool under `read` returns the level message; `send_email` under `organize` points to `create_draft`; the not-reachable message.
- **e2e** (`settings.spec.ts`, the existing `agents` describe): the setup shows the Other apps snippet with the app's path; Allow agents is off and the token row hidden; turning it on shows the level and the token row, and an agent can connect; choosing a level survives reopening Settings; turning it off cuts the agent. One flow, in macOS (no design changes its result).
- Typecheck, lint, the i18n guard.

## Performance and resources

- Off (the default): no socket, no listener, no file. Less than today.
- `authorize` does one settings read per agent call, without secrets; agent calls are not a hot path, and renderer calls skip it (`origin !== "mcp"` returns first).
- No new timers, no polling: the connector reacts to `settings.update` only.

## Out of scope

- Spam and Trash, attachments: plan 184.
- Per-agent tokens or per-app approval prompts (a dialog when a new agent connects). Worth considering later; the token file stays the boundary.
- Hiding tools by level with `tools/list_changed`: refusal with a reason serves the user better (see above).
- A one-click "Add to Claude Desktop" that writes another app's config.

## Revisions after the Codex review

1. **Filing into a forwarding category needs `send`, everywhere.** `categories.addThreads` from an agent never called `agentMayFile`, and a later reply in a filed conversation forwards whoever filed it (`membershipForwards`: membership older than the message). A pre-existing hole, closed here: `addThreads`, `moveThreads` and `categorize.apply` (with or without `always`) from `mcp` check `agentMayFile`. Test: an agent at `organize` can't file into a forwarding category; at `send` it can, and a later reply forwards.
2. **Closing cuts every connection.** `startAgentSocket` tracks sockets from acceptance, not after the handshake; a closing endpoint refuses handshakes and destroys authenticated and pending sockets alike, so `server.close()` can't hang. Test: turning agents off during a handshake.
3. **`enabled` is part of the gate.** `authorize` refuses every `mcp` call while agents are off (a connection that outlived the switch gets nothing), and the effective send permission is `enabled && access === "send"` (`agentMayFile`, `Forwarding.agentsMaySend`).
4. **Import goes through the same side effects.** `importData` syncs the connector after it writes settings.
5. **Import can only turn agents off.** It never sets the level (raising or lowering it from an earlier snapshot races a change made meanwhile); `enabled: false` in a file applies as a partial patch, which can only lower. An old file's `allowAgentSend` is ignored.
6. **Freshness comes from the raw object.** `migrateAgents` takes `fresh` computed before any migration (as `migrateAppearance` does), because the earlier migrations stamp an empty object. Tested through `readSettings` on an empty and an existing store, not only the pure function.
7. **The patch is partial and merged inside the updater.** `agents: { enabled?: boolean; access?: AgentAccess }` in the patch schema, merged onto the latest stored value in `patchedSettings`, so another window's stale copy can't restore a sibling field.
8. **Stop fences the connector.** It gets a terminal stopped state: `stop()` awaits the chain, closes the endpoint, and a start that resolves after it closes what it opened at once. `BackendCore.stop` awaits it before closing the store. Test: stop while a start is pending.
9. **A failed start leaves nothing behind.** `startAgentSocket` removes its token file (and socket) when listening fails; the chain recovers from a rejection; `agents.status` reports `enabled` with `running: false` and the tab says it couldn't start, in plain English, with what to do (quit and reopen Terno). The next toggle retries.
10. **The MCP bootstrap cache is tied to its connection.** It is reused only for the same live client; a closed connection drops it, so an agent cut off by the switch can't keep reading accounts and counts from it.
11. **Every caller of the old field moves**: `writing.test.ts`, `appearance.test.ts`, `settings-edits.test.ts` (an agent's draft write now needs access), `forwarding.test.ts`, `backend.test.ts`, `mcp.test.ts`, and the e2e fixture; each grants the level it needs.
