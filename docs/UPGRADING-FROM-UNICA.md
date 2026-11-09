# Upgrading from Única

Terno was called Única. The first launch of Terno carries everything over by itself ([PLAN §14](PLAN.md#14-rename-única--terno)):

- **Mac:** `~/Library/Application Support/Unica` becomes `…/Terno` (renamed, never copied; quit Única first) and `unica.db` becomes `terno.db`. Passwords, tokens and API keys sealed in the Keychain as "Única Safe Storage" are sealed again under Terno's item (macOS may ask once whether Terno may use the old item). Anything that can't be opened stays where it was and Settings asks you to enter it again. The dev profiles `Unica-dev-seeded`/`Unica-dev-demo` are renamed on their next `pnpm dev:desktop:*`.
- **Web:** the mailbox, its key store, caches and settings move from Única's storage names to Terno's in the browser, and a tab still running the old build hands the mailbox over.
- **Variables:** `UNICA_*` still work for one release (with a warning); use `TERNO_*`.
- **Agents:** re-add the MCP server with the commands in [MCP.md](MCP.md) (or in Settings → Agents) and copy the skill to `~/.claude/skills/terno`.
