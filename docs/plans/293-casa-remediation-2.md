# Plan 293: CASA remediation, second round (6.2.1, 4.1.4, 2.2.1, 6.7.1, 6.5.1, 5.2.1, 6.6.1)

- **Status:** planned
- **Why:** TAC Security's CASA Tier 2 review of Terno's Gmail verification failed nine controls (2026-11-27). Six need product changes, one (6.6.1) needs an exact inventory. The tester's comments are in `~/.cache/terno-casa-evidence/tac-findings/findings.md` ("Failed findings"); each section below quotes what the tester asked for.

## The request (verbatim)

<details><summary>The owner's brief</summary>

> You are working on Terno, an Electron mail client in a pnpm monorepo. Read AGENTS.md first and follow its "How a feature is built" process: plan, Codex critique of the plan, atomic commits with tests, Codex code review with every finding fixed, and only the relevant tests. You are in your own git worktree based on main. Commit there and never push. When you finish, I'll land your commits on main with a rebase and fast-forward.
>
> ## Background
> Terno is going through a Google CASA Tier 2 security assessment with TAC Security for its Gmail OAuth verification. The tester failed 9 controls. Their verbatim comments are in `~/.cache/terno-casa-evidence/tac-findings/findings.md`; read the "Failed findings" section. This task covers the six that need product changes. Evidence capture and the TAC portal are handled elsewhere: just produce code, tests, and a short written report per control that I can turn into evidence.
>
> Earlier context:
> - `docs/plans/283-no-debugging-in-releases.md` covers the Electron fuses and the RunAsNode residual. It already describes the clean end state for the MCP connector.
> - `apps/desktop/scripts/fuses.mjs` and the release check that reads the fuses back from the binary.
> - `resources/bin/terno-mcp`: today it runs `ELECTRON_RUN_AS_NODE=1 exec <Terno binary> Resources/mcp/terno-mcp.cjs`.
> - Plan 183/189 describe the MCP connector, and plan 10 diagnostics/logging.
>
> Use ONE new plan, `docs/plans/NNN-casa-remediation-2.md`. Pick the next free number: check `docs/plans`, `docs/plans/drafts` and `git log --all` for 291–293+ in flight; numbers 291 and 292 are taken. Give each control its own section.
>
> ## The six fixes
>
> ### 1. 6.2.1: RunAsNode off in shipped builds
> The tester wants RunAsNode disabled, with evidence that the MCP connector can't start an inspector or run through a debug entry point.
> - Implement the end state plan 283 proposed: move the MCP server into the running app (the backend or main, whichever is cleaner; it already has the agent socket with its per-start token file), and make the agent's command a tiny stdio↔socket bridge with no Node and no Electron.
> - The bridge should be a small native helper (C or Swift). It is built during packaging for macOS arm64 and Linux x64 (the release workflow runs on GitHub's macOS and Ubuntu runners), placed in Resources, and signed and notarized with the app. Check that electron-builder signs it and that hardened runtime and notarization accept it.
> - Keep the agent-facing UX as close to today as you can:
>   - Today, when Terno isn't running, the server answers with an "Open Terno…" message.
>   - Pick the closest clean behaviour (for example, the bridge answers the MCP `initialize` and `tools/list` itself with a clear "Terno isn't running, open it" error), and say what you chose in the plan.
>   - Settings → Agents hands agents the command; keep that path working. Also handle the existing installs that already point at `resources/bin/terno-mcp`.
> - Then set RunAsNode OFF for shipped builds in `fuses.mjs` and in the release-time verification. Inspectable builds may keep whatever the smoke suite needs; say what and why.
> - Update the smoke tests that call the connector (`packaged.smoke.ts`, `links.smoke.ts`, `linux.smoke.ts`).
> - Add a test or check proving `ELECTRON_RUN_AS_NODE=1 <binary> --inspect …` no longer gives a Node runtime on a shipped build.
> - If this turns out to need a refactor beyond this scope, or a UX decision you can't make cleanly, STOP and report back with the options instead of building it.
>
> ### 2. 4.1.4: crypto failures fail with a generic code
> The tester found raw exception text forwarded to the renderer and in migration logs.
> - Every safeStorage/keychain failure path (keychain unavailable, decrypt/padding/MAC/key validation, migration of old blobs) should:
>   - return one fixed, generic user-facing error with a fixed category code;
>   - log only that code, never `err.message`, stack, key material or plaintext.
> - Find every place (grep `safeStorage`, `decryptString`, `encryptString`, the keychain helper, credential migration) and add tests asserting that the renderer response and the log line hold no exception text.
>
> ### 3. 2.2.1: an expired or revoked grant deletes the refresh token
> The tester wants evidence that session expiration invalidates the session and deletes or revokes the stateful refresh token, not only that an expired access token prompts sign-in again.
> - Check what happens today when Google's token endpoint answers `invalid_grant`: revoked, expired (Testing-mode 7 days, unused 6 months) or a password change.
> - Make that path delete the stored refresh token and the in-memory access token, mark the account as needing sign-in, and drop any cached auth state. Do the same for IMAP/Outlook credentials if there is an equivalent "credentials rejected permanently" path, but only where a documented signal exists. Never delete on a transient network error.
> - Write unit tests that clearly show it, since they'll be cited as evidence. Also confirm, and test if missing, that Remove Account deletes the tokens and revokes them at Google.
>
> ### 4. 6.7.1: secret access is recorded and monitored
> - Add a bounded, local "credential access log": every read or decrypt, write, delete and failed attempt on a stored secret (OAuth refresh token, IMAP/SMTP password, user AI API key) records the time, operation, which component asked, the account's internal id (no email address or name, per the privacy rules in AGENTS.md and plan 10), and the outcome.
> - It lives with the existing diagnostics logs, bounded in size like them.
> - Repeated failures should be noticeable: at minimum, decrypt failures are surfaced to the user (they probably already are, as "sign in again"); reuse what exists.
> - If there's a natural place for the user to see it (the diagnostics export or Settings → Privacy/Diagnostics), use the existing UI only; no new screens unless trivial. Everything stays on the machine.
> - Add tests.
>
> ### 5. 6.5.1: the sign-in process logs with redaction
> The tester wants a login-process log excerpt showing the request and response of the credential submission, with sensitive values redacted.
> - Make sure the Gmail OAuth sign-in (PKCE loopback) logs its steps:
>   - authorization started (method S256, loopback port);
>   - callback received (code redacted, state verified);
>   - token exchange `POST https://oauth2.googleapis.com/token`, with the HTTP status and response field names, values redacted (`access_token=[redacted]`, `refresh_token=[redacted]`, `expires_in`, `scope`);
>   - credentials stored encrypted.
> - The IMAP/SMTP login should log `LOGIN user=[redacted] → OK/NO`, or whatever the library allows.
> - Use the existing logger and scrubber, and keep the log bounded and local.
> - Add tests asserting that no code, token, password or email address reaches the log.
>
> ### 6. 5.2.1: outgoing attachments checked against Gmail's blocked file types
> - Gmail documents the file types it blocks (support.google.com/mail/answer/6590). Fetch the page and use exactly its list: executables, certain archives containing them, and so on. Don't invent entries; see the memory rule "no undocumented provider behaviour".
> - For Gmail accounts, when the user attaches (or at the latest before send), refuse a blocked type with a calm, plain-English message saying Gmail won't send that file type. Check the existing attachment size limit too; keep it, or add Gmail's documented 25 MB if missing.
> - Validate the real content signature for the obvious executable formats (MZ, ELF, Mach-O, shebang scripts), not just the extension.
> - New strings go in `en` and `es`.
> - Unit tests, plus an e2e if a composer flow changes.
>
> ## Also, for 6.6.1 (no code change expected)
> Write an exact inventory of browser storage in the DESKTOP renderer: localStorage, sessionStorage, IndexedDB, Cache Storage, service workers, cookies, WebSQL, file system. For each, say whether it's used, which keys or databases, and whether anything confidential or any authentication material is in it. Back it with a code search and, if practical, a runtime check on a dev or inspectable build with a temp profile.
> - Never touch real profiles in `~/Library/Application Support/Terno*`.
> - Unset `ELECTRON_RUN_AS_NODE` when launching.
> - If removing an account should clear something in renderer storage that it currently doesn't, fix it.
>
> ## Constraints
> - Every rule in AGENTS.md applies: privacy, i18n, BoardUI, no lazy loading, perf, process safety (kill only PIDs you started).
> - Node: use fnm v24.21.0, not Homebrew Node 24.3.0.
> - `pnpm dist:mac` plus the affected smoke tests are needed for item 1; run them in the background without stealing focus (`TERNO_TEST_BACKGROUND=1`).
> - Do not release, push or tag. I'll do the release.
>
> ## Report back
> 1. The commit list.
> 2. For each of the 6 controls (plus 6.6.1): the files and tests to cite as evidence, with paths and line numbers, the test command and its output, and a 2–4 sentence plain description of the behaviour for the assessor.
> 3. Anything you skipped or couldn't verify.

</details>

---

## 1. Control 6.2.1: RunAsNode off; the MCP server inside the app

> Tester: "the production release explicitly leaves RunAsNode enabled for the MCP connector, and testing shows that this path can start a Node inspector … Disable RunAsNode and the associated Node inspector/debugging capability in the production MCP connector."

### What exists

- `resources/bin/terno-mcp` (shell) runs `ELECTRON_RUN_AS_NODE=1 exec <Terno> Resources/mcp/terno-mcp.cjs`, a bundle of `packages/mcp/src/bin.ts`: an MCP stdio server (`server.ts`, the SDK's `McpServer`) whose tools call the backend through `AppConnection` (`connection.ts`): it reads the token file, connects to the profile's `agent.sock`, sends the token, then speaks the backend's NDJSON RPC as origin `mcp`. Offline (no token file, no socket), every tool call answers `"Can't reach Terno. Open Terno and turn on Settings → Agents → Allow agents, then try again."` as a tool error, while `initialize` and `tools/list` work (the server itself runs). A connection lost mid-call gives the same message. It reconnects lazily on the next call.
- `startAgentSocket` (`packages/backend/src/agent-socket.ts`): Unix socket + 0600 token file, per-start token, owned by the `AgentConnector` (plan 183: exists only while agents are on). After the token line it hands the socket to `backend.connect(socketTransport(socket), { origin: "mcp" })`. `BackendCore.authorize` gates every `mcp` call by the access level.
- `fuses.mjs`: RunAsNode **on** in both kinds; release.mjs and the packagers read the wire back.
- Callers of the connector: Settings → Agents shows `mcpCommand` (`app.ts:829`, `Resources/bin/terno-mcp`); `packaged.smoke.ts`, `links.smoke.ts`, `linux.smoke.ts`, `debugging.smoke.ts`; `packages/mcp/src/mcp.test.ts`; `diagnostics.smoke.ts` expects `dist/mcp/terno-mcp.cjs.map`.
- Playwright's `_electron.launch` with an `executablePath` passes `--inspect=0 --remote-debugging-port=0` and no `-r` loader (playwright-core 1.64.1, `coreBundle.js`): it needs the inspect fuse, never RunAsNode.

### Design

**The server moves into the backend.** The backend already owns the socket, the token and the gate; main has none of it. After a good token line, `startAgentSocket` no longer speaks RPC on the socket. It connects an in-process RPC client to the backend (`createMemoryTransportPair`, `backend.connect(…, { origin: "mcp" })`, so `authorize` and every level check are unchanged) and hands the socket and that client to a `serve` function given with the endpoint paths. The socket now carries MCP's own stdio framing (one JSON-RPC message per line), exactly what the agent writes on its stdin.

- `packages/mcp` keeps the protocol layer and loses its process: `server.ts` (`createMcpServer(app: AgentCalls)`, where `AgentCalls` is `Pick<RpcClient, "call">`), plus `serveMcp(socket, app, version)`: an `McpServer` on the SDK's `StdioServerTransport(socket, socket)`, wrapped to count requests in flight. When the bridge half-closes (its stdin ended), the session waits until every request in flight is answered, then ends the socket. That replaces `bin.ts`'s 50 ms sleeps and `drain()` poll with exact accounting.
- `bin.ts`, `connection.ts`'s socket client (`connectToApp`, `AppConnection`), `profile.ts` and `diag.ts` (logs/mcp.jsonl, mcp crash records) go: the server's diagnostics are the backend's now (`mcp.tool_failed` is captured in the backend process). `Proc` keeps `"mcp"` so records from older builds still validate.
- The dependency points one way: `@terno/backend` doesn't import `@terno/mcp`. `AgentPaths` gains `serve: AgentServe` (`(socket, rpc) => Promise<void>`); the composition roots give it: `apps/desktop/src/backend-entry.ts` and `apps/backend-dev` (`serve: (s, rpc) => serveMcp(s, rpc, version)`).
- The handshake reads bytes (not strings), so a frame split inside a UTF-8 character can't be mangled, and the socket server is `allowHalfOpen` so the bridge's half-close doesn't end the reply stream.
- Bundle: the backend bundle gains the SDK's server and its zod use (zod is already in it). Plan 156's V8 code cache covers the compile after the first launch. No lazy loading.

**The agent's command is a native bridge, at the same path.** `apps/desktop/native/terno-mcp.c` (C11, POSIX only: `poll`, `socket(AF_UNIX)`, `read`/`write`; no Node, no Electron, nothing it loads or runs), compiled at packaging into `Resources/bin/terno-mcp`, **replacing the shell script at the same path**. Every existing agent config (Settings → Agents has always handed out `…/Resources/bin/terno-mcp`) keeps working with no change; `mcpCommand` is untouched.

- It finds the socket and token as `packages/mcp/src/profile.ts` did: `TERNO_SOCKET` / `TERNO_TOKEN_FILE`, else `<profile>/agent.sock` and `agent.token`, where the profile is `TERNO_USER_DATA`, else `~/Library/Application Support/Terno` on macOS, `${XDG_CONFIG_HOME:-~/.config}/Terno` on Linux.
- Connected: it reads the token (fresh on every attempt, so a rotated token is picked up), connects, sends the token line, waits up to 5 s for `{"ok":true}`, then copies whole lines both ways. On stdin's end it half-closes the socket and keeps copying until the app ends it, so a last tool call's answer arrives.
- **When Terno can't be reached (the UX choice).** The closest behaviour to today: the bridge answers as today's server did while offline, from a manifest generated at packaging from the real server (`offlineManifest()` in `packages/mcp`, written into a C header):
  - `initialize`: the server's own result (capabilities, `serverInfo`, `instructions`), with the protocol version negotiated as the SDK does (the client's when supported, else the latest);
  - `tools/list`: the server's real tool list (same names, schemas, annotations);
  - `ping`: `{}`;
  - `tools/call`: the same tool error as today, `"Can't reach Terno. Open Terno and turn on Settings → Agents → Allow agents, then try again."` (a rejected token: `"Terno rejected the connection (stale token). Restart Terno."`);
  - any other request: JSON-RPC `-32601` (what the SDK server answers for methods it doesn't serve); notifications are dropped.
  - Every request tries the socket again first, so a session started before Terno opened works once it does: on a new connection the bridge first replays the agent's `initialize` (its own id, its answer swallowed) and `notifications/initialized`, then forwards the request.
  - If the connection drops with requests in flight (Terno quit, agents turned off, token rotated), each is answered as offline (a `tools/call` gets the "Can't reach Terno" error), as `AppConnection.call` did.
  - The alternative (the bridge listing no tools while offline) would leave an agent that started first with no tools after Terno opens; the manifest keeps today's behaviour exactly.
- JSON handling is a small top-level scanner: it reads a line's `id`, `method` and `params` spans without decoding values (strings and nesting are skipped correctly); every response it writes is a fixed template around the request's raw `id`.
- **Built at packaging** by `apps/desktop/scripts/mcp-bridge.mjs`: `build.mjs` writes `dist/native/mcp-offline.json` (it bundles and runs a tiny manifest entry, so the list is the shipped server's); `package.mjs` compiles `darwin-arm64` with `cc -arch arm64 -mmacosx-version-min=12.0 -O2 -Wall -Wextra -Werror`, `package-linux.mjs` each architecture with `gcc` (x64) and `aarch64-linux-gnu-gcc` (arm64; the release workflow installs `gcc-aarch64-linux-gnu`). It lands in `Resources/bin/terno-mcp` through `extraResources` (`${os}-${arch}`), `dist/native/**` stays out of the asar, and `dist/mcp/` keeps only `SKILL.md`.
- **Signing.** electron-builder (`@electron/osx-sign`) signs every Mach-O in the bundle, `Resources/bin` included, with the app's identity and, for a Developer ID build, the hardened runtime and secure timestamp; notarization accepts a nested executable signed so. `release.mjs build-mac` now checks the bridge too: a thin `arm64` Mach-O, signed by the app's team, hardened runtime flag set, and `codesign --verify --strict` passes. `package-linux.mjs` checks it's an ELF of each architecture whose glibc needs are no newer than Electron's own binary's.

**The fuses.** `fuseTable` sets `runAsNode: false` for **both** kinds: nothing needs it any more (Playwright doesn't, the keychain helper runs the full app, the backend is a `utilityProcess`). The inspectable kind still differs only by the inspect fuse. release.mjs's checks read it back, and `fuses.test.ts` pins it.

**Proof it's gone** (`debugging.smoke.ts`, every kind, no app launch): `ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--require <probe> Terno [--inspect=0 on a shipped build] --remote-debugging-port=0 -e <write a marker>` must print Terno's own CDP refusal and exit 1: the browser process ran, not Node; the `-e` script never ran, the `--require` probe never ran, no "Debugger listening". The control runs Electron's stock binary with the same variables and sees the marker written, so the probe can tell. The "NODE_OPTIONS reaches Terno run as Node" test goes (that mode is gone). The `@launches` test still drives the bundled `terno-mcp`, now the bridge.

### Tests

- `packages/mcp/src/mcp.test.ts`: the server through `serveMcp` on a real agent socket (as the bridge speaks it); the existing tool tests on an in-process client; the half-close drain (a last `tools/call` written just before EOF is answered); `offlineManifest()` equals the live server's `initialize` result and `tools/list`.
- `apps/desktop/src/mcp-bridge.test.ts` (unit; compiles the bridge with the host's `cc` into a temp dir, skipped with a reason when there is none): offline `initialize`, `tools/list` (the manifest's), `ping`, a tool call's "Can't reach Terno" error, an unknown method's `-32601`; Terno started after the session began: the next call works (replayed initialize, nothing extra on stdout); agents turned off mid-session: the call in flight gets the offline error; a stale token's message; EOF after a last call still prints its answer; a line split across reads and a UTF-8 value pass through unchanged.
- `packages/backend/src/agent-access.test.ts`: the handshake tests on the new `serve` seam.
- `fuses.test.ts`: RunAsNode off in both kinds. `debugging.smoke.ts` as above.
- Smokes: `packaged.smoke.ts`, `links.smoke.ts` spawn the same path (now native); `linux.smoke.ts`'s wrapper test runs it against the installed app (CI). `diagnostics.smoke.ts` no longer expects `mcp/terno-mcp.cjs.map`.
- Run: `pnpm dist:mac`, then `packaged`, `links`, `debugging`, `diagnostics` smokes; then a shipped build (`TERNO_SHIPPED=1`, its own output) and `debugging.smoke.ts` against it.

---

## 2. Control 4.1.4: crypto failures fail with one generic code

> Tester: "the code also forwards the raw exception text to the renderer and logs migration error messages … Return the same generic user-facing error for keychain-unavailable, padding/decryption, MAC or key-validation, and migration failures … Replace raw exception text … with a fixed safe error category or code."

### What exists

- Main's `secret` handler (`app.ts:311-323`) posts `error: String(error)` (Electron's text, or "Keychain encryption unavailable") to the backend; `legacy-secrets` (`:324-330`) the same, unlogged. The backend's cipher rebuilds `new Error(msg.error)` (`backend-entry.ts:136`).
- Four encrypt callers don't catch, so that text reaches the renderer as an `INTERNAL` RPC message (`toErrorPayload`) and becomes a `rpc.handler_threw` crash record: `accounts.addImap` (`handlers.ts:1342`), `accounts.connectGmail` (`:1393`), `accounts.connectMicrosoft` (`:1433`), `ai.setKey` → `setSecret` (`core.ts:1379`), and the provider context's `setSecret` (`core.ts:2161`).
- The legacy migration logs `error.message` (`keychain.ts:142`, `:157`) and `core.ts:871-874` logs `error.message` after `keychain.migration_failed`.
- Decrypt failures already become fixed `SecretUnreadableError` messages (`core.ts:1366-1377`); `identity.ts`'s encrypt wraps into `errors.secret.replaceFailed`.
- `keychain.secret_failed` logs `op` and `errorClass`. The web build's cipher (AES-GCM in a worker) goes through the same backend paths.

### Design

One seam, `packages/backend/src/secret-access.ts`: `SecretAccess` wraps the `SecretCipher` (and the legacy reader) and is the only way backend code seals or opens a secret (`b.secrets.seal(…)`, `b.secrets.open(…)`; the raw `options.cipher` is used nowhere else, enforced by a source scan test). Any failure inside the cipher, whatever its cause (keychain unavailable, wrong key, padding, MAC, truncated blob, a refused async API), becomes **one** error:

- `SecretStorageError` (expected, so no crash record and no stack anywhere), category code `secret_storage_failed`, message `L("errors.secret.storage")`: "Terno couldn't use the system keychain to protect your sign-in. Check that the keychain is unlocked, then try again." (es too).
- Opening still maps to the existing per-kind `SecretUnreadableError` messages ("The keychain won't open this account's password…", which say where to enter it again): those are generic too (no exception text) and they tell the user what to do; they now carry the same category code.
- Logged as `log.warn("secret.failed", { secretOp, category })`: fixed fields only.
- The four encrypt callers get it through the seam; handlers need no try/catch of their own.

Main and the IPC carry no text: `secret-result` becomes `{ ok: false }` with no `error` field; main logs `keychain.secret_failed` with `op` only (no `errorClass`, which the tester can read as exception detail). `legacy-secrets` the same, and logged. The migration logs fixed codes (`keychain.migration_failed`, `keychain.legacy_unreadable` with a count), never a message or a secret's name.

### Tests

- `secret-access.test.ts`: a cipher throwing texts that name a padding error, a MAC failure, a key ("BEGIN PRIVATE KEY …"), plaintext, and a stack: `seal` and `open` throw `SecretStorageError` whose message, `toErrorPayload` result (what the renderer gets) and every captured diag entry contain none of them; the error is expected and has no cause.
- `handlers` (backend test): `accounts.addImap` and `ai.setKey` with a failing cipher: the RPC error the renderer receives is `errors.secret.storage` with code `secret_storage_failed`, and no log line holds the text.
- `keychain.test.ts`: a migration whose legacy reader and cipher throw texts: logs hold neither.
- `apps/desktop/src/ipc` (unit on the main handler extracted as `secretReply`): the reply has no `error` text, the diag entry only `op`.

---

## 3. Control 2.2.1: a revoked or expired grant deletes the refresh token

> Tester: "Provide code or test evidence showing that session expiration invalidates the application session and deletes or revokes any stateful refresh token, not only that an expired provider access token causes a new sign-in."

### What exists

- Google's token endpoint answering `400 invalid_grant` (revoked, expired: Testing-mode 7 days, unused 6 months, a password change for Gmail scopes) becomes `ProviderAuthError(errors.gmail.revoked)` (`gmail-refresh.ts:23`); Microsoft's `400 invalid_grant | interaction_required | consent_required` → `errors.microsoft.revoked` (`microsoft.ts:185-192`).
- The OAuth session (`oauth-session.ts`) reports it (`tokenResult`) and the account goes to `authRequired` (`account-status.ts`); ops park at `AWAITING_AUTH`; polling stops. **But the refresh token stays stored** (`gmail.int.test.ts:904` asserts it), and the session's `candidate` survives; `access` keeps an expired value.
- Remove Account (`handlers.ts:441-467`, `core.ts:2247-2320`) closes the provider (in-memory token nulled), deletes every `account:<id>:*` secret in the same transaction as the account, then revokes at Google (`POST https://oauth2.googleapis.com/revoke`, 200 = revoked) and tells the user if it wasn't confirmed. Tested in `google-connection.test.ts:412-515` and `microsoft-connection.test.ts:422-429`.

### Design

- The refusal carries what it proves: `ProviderAuthError` gains `grantRejected: true` only for the token endpoint's `invalid_grant` (Google: `400 invalid_grant`, which Google documents as "the refresh token has expired or been revoked"; Microsoft: `400 invalid_grant`, documented as an expired or revoked refresh token). `interaction_required`/`consent_required` (Microsoft) still ask for sign-in but don't delete: they say the user must act, not that the token is dead.
- On such a refusal the OAuth session drops `access` and `candidate`, then asks the context to **discard** the refresh token it used: `ctx.discardSecret("refreshToken", expected)`. The backend deletes it only if the stored blob still opens to that token: a store-level compare-and-delete, `secrets.remove(name, expectedBlob)` (SQLite `DELETE … WHERE name = ? AND blob = ?`, IndexedDB in one transaction), so a sign-in that saved a new token meanwhile is never touched. Then the account is marked as needing sign-in (as today), and the account's cached Google token (web broker `gmailTokens.forget`) is dropped.
- Signing in again after that is the existing path: `credentialSnapshot` finds no secret, the intent expects none, the new token is committed.
- Never on transient errors: network failures, 429, 5xx, an unreadable body, a non-400 status with `invalid_grant`, or a timeout keep the token (existing classification, `gmail-refresh.test.ts:197-207`).
- IMAP/SMTP: **no deletion.** A login refusal (`AUTHENTICATIONFAILED`, SMTP 535) has no documented "permanently rejected" meaning: servers send it for throttling and temporary outages too, which is why plan 25 rechecks the saved password on start, network and focus. Deleting it would make the user type it again after a server hiccup. The account is marked as needing sign-in, as today.
- Gmail API 401 after a fresh token: not a refresh-token verdict (Google says to refresh and retry); kept.

### Tests

- `packages/mail/src/oauth-session.test.ts` (or the existing `oauth-loopback.test.ts` session cases): `invalid_grant` → `discardSecret("refreshToken", <the token used>)` called once, the next `get()` refreshes again (no cached access token), and `tokenResult` reports the refusal; a 503, a 429 and a network error → no discard, token kept.
- `packages/backend/src/gmail.int.test.ts`: the expired-grant case now asserts the stored refresh token is **gone**, the account `authRequired`, ops parked; signing in again stores a new token and resumes. A 503 from the token endpoint keeps the token.
- `microsoft-connection.test.ts`: `invalid_grant` on refresh deletes the token and asks for sign-in; `interaction_required` asks for sign-in and keeps it.
- Store conformance (`packages/store/src/conformance`): `secrets.remove` deletes only on equal bytes, on both engines.
- Removal: the existing `google-connection.test.ts` cases are cited; one assertion is added if missing (every `account:<id>:*` secret is gone before the revoke request is made, and the revoke carries the stored token).

---

## 4. Control 6.7.1: every secret access is recorded

> Tester: "it does not demonstrate that access to stored secrets is logged or monitored … Provide evidence that secret access and retrieval attempts are recorded and monitored."

### Design

`SecretAccess` (§2) records every access as a structured diagnostics line, code `secret.access`:

| Field | Values |
|---|---|
| `ts` | the entry's own time |
| `secretOp` | `read`, `write`, `delete` |
| `secretKind` | `refreshToken`, `password`, `apiKey`, `clientSecret`, `other` (from the secret's name) |
| `component` | `sync`, `send`, `signIn`, `refresh`, `recheck`, `revoke`, `removal`, `ai`, `settings`, `migration`, `other` |
| `accountId` | the account's internal row id (an integer; never its address or name), absent for app secrets |
| `outcome` | `ok`, `missing`, `failed` (the keychain refused), `refused` (a compare-and-swap that didn't match) |

- Every backend path goes through it: reads (`getSecret`, the provider context, identity's renewal reads, the keychain recheck, the revoke read), writes (account creation for IMAP/Gmail/Outlook, rotation, reconnect, AI keys), deletes (account removal, AI key removal, §3's discard, the legacy client secret). A source scan test fails if `store.secrets.*` or the raw cipher is used outside `secret-access.ts` and the store packages.
- **Bounded, local.** The lines go where the backend's diagnostics go (`logs/backend.jsonl`, 2 MB × 5 on desktop, the 2,000-entry ring on web), so they rotate like the rest and leave the machine only in a diagnostics export the user makes. The code is marked `local`: it never enters the breadcrumb ring, so it's never in an error report (plan 78) even with consent.
- **Volume.** Successful reads of the same secret by the same component are folded: the first is written at once, repeats within 60 s add to a `count` written when the minute ends (one unref'd timer while a fold is open, none when idle). Writes, deletes and every failure are written one by one. So an AI pass that opens the key a thousand times writes two lines, not a thousand.
- **Monitored.** A failure is a `warn`, and the user already sees one where it matters: a password or Google session the keychain won't open puts the account in "Sign in again" (`authRequired`), an API key the keychain won't open says so in Settings → AI. Three failed opens of the same secret within ten minutes also write `secret.failures_repeated` (warn, with the kind and count), so a run of them is one line to find in an export.
- **Where the user sees it:** Settings → General → Diagnostics → Export (existing): the archive's `logs/backend.jsonl` holds the lines. No new screen.

### Tests

- `secret-access.test.ts`: one line per write, delete and failure with exactly the fields above; folding (100 reads → one line, then `count: 99` when the minute ends; nothing pending → no timer); the repeated-failure line after the third failure in ten minutes; no line holds a secret, an address or exception text; the code is local (not in `breadcrumbs()`).
- Integration (backend): adding an IMAP account, a sync, removing it: write → read → delete lines with that account's id, in order.
- Source scan: no `store.secrets.` or `options.cipher` outside the seam.

---

## 5. Control 6.5.1: the sign-in process logs its steps, redacted

> Tester: "Provide the actual login-process log excerpt showing the request and response associated with the credential submission, with sensitive values safely redacted."

### Design

Sign-in logs through the same structured diagnostics (typed fields only, `logs/backend.jsonl`), new codes in `codes.ts`:

| Step | Code | Fields |
|---|---|---|
| authorization started | `signin.authorize` | `provider` (google, microsoft), `pkce: "S256"`, `port` (the loopback's), `redirectHost` |
| callback received | `signin.callback` | `state: "verified"` (a mismatch: `signin.callback_rejected`, `state: "mismatch"`), `code: "[redacted]"` |
| token exchange | `signin.token_exchange` | `method: "POST"`, `endpoint` (`https://oauth2.googleapis.com/token` or Microsoft's), `status`, `request: "grant_type=authorization_code code=[redacted] code_verifier=[redacted] client_id redirect_uri"`, `response: "access_token=[redacted] expires_in=3599 refresh_token=[redacted] scope=<granted scopes> token_type=Bearer id_token=[redacted]"` |
| identity read | `signin.identity` | `status` (the profile request's), `email: "[redacted]"` |
| stored | `signin.stored` | `encrypted: true`, `accountId` |
| refresh | `token.refresh` | `status`, `response` as above (`refresh_token` only when rotated) |
| IMAP login | `imap.login` | `user: "[redacted]"`, `result: "OK" \| "NO"` (`NO` with the response code, e.g. `AUTHENTICATIONFAILED`), `mechanism` |
| SMTP login | `smtp.login` | `user: "[redacted]"`, `result: "OK" \| "NO"`, `responseCode` (535…) |

- The request and response summaries are built by one function, `redactedForm(fields, keep)`, that writes every **name** and only the values on an allowlist (`expires_in`, `token_type`, `scope`, `grant_type`); everything else is `[redacted]`. The diag field type for them is a constrained string (letters, digits, `_ = [ ] . : / - space`), so a value that slipped past would be refused by the sanitizer, not written.
- The log never holds the authorization code, the PKCE verifier, any token, a password, an address or a name. The IMAP library's own logger stays off (imapflow's custom logger has no debug/info, nodemailer's transcript is read in memory only); the login lines are ours, written on the outcome.

### Tests

- `packages/mail` (`oauth-loopback.test.ts`, `gmail` sign-in): a full sign-in against a fake browser and token endpoint, with a known code, verifier, tokens and address: the captured entries are the sequence above, and serialized they contain none of the code, verifier, access token, refresh token, id token or address.
- `imap.login`/`smtp.login` against the existing loopback servers (`smtp-starttls.test.ts`, IMAP test server): OK and NO, with the password and user absent.
- `fields.test.ts`: the redacted-string type refuses a token-shaped or address-shaped value.

---

## 6. Control 5.2.1: outgoing attachments checked against Gmail's blocked types

> Tester: "it does not describe file-type validation for the outgoing attachment operation … Describe and demonstrate the file-type validation applied when users attach files to outgoing mail."

### What Gmail documents (fetched 2026-11-27, support.google.com/mail/answer/6590)

> To protect your account from potential viruses and harmful software, Gmail doesn't allow you to attach:
> - Certain types of files, including their compressed form (like .gz or .bz2 files) or when found within archives (like .zip or .tgz files)
> - Documents with malicious macros
> - Password-protected archives with archived content
>
> File types blocked by Gmail are: .ade, .adp, .apk, .appx, .appxbundle, .bat, .cab, .chm, .cmd, .com, .cpl, .diagcab, .diagcfg, .diagpkg, .dll, .dmg, .ex, .ex_, .exe, .hta, .img, .ins, .iso, .isp, .jar, .jnlp, .js, .jse, .lib, .lnk, .mde, .mjs, .msc, .msi, .msix, .msixbundle, .msp, .mst, .nsh, .pif, .ps1, .scr, .sct, .shb, .sys, .vb, .vbe, .vbs, .vhd, .vxd, .wsc, .wsf, .wsh, .xll

and "Gmail blocks messages that may spread viruses, like messages that include executable files." Size (answer/6584): "For personal Gmail accounts, the limit is 25 MB. For work and school accounts, your Google Workspace administrator sets the attachment sending limits."

### Design

A pure checker in `packages/core/src/gmail-blocked.ts`, `gmailBlocked(name, bytes)` → `null | { reason: "type" | "compressed" | "archive" | "protected" | "executable", ext? }`:

- **type:** the name's last extension, case-insensitive, is on the list (exactly the 54 above, quoted with the page's date).
- **compressed:** `.gz` or `.bz2` over a listed extension (`setup.exe.gz`).
- **archive:** a `.zip` whose central directory names a listed file (or its `.gz`/`.bz2`), or a `.tgz`/`.tar.gz`/`.tar` whose tar headers do (gzip through `DecompressionStream`/zlib, bounded to the attachment limit). Nested archives aren't opened (not documented).
- **protected:** a `.zip` with an encrypted entry (general-purpose flag bit 0) that isn't a directory: "password-protected archives with archived content".
- **executable** (the content, whatever the name): `MZ` (PE), `\x7FELF`, Mach-O (`FEEDFACE`/`FEEDFACF` either byte order; fat `CAFEBABE` only with a plausible architecture count, so a Java class file isn't one), and a `#!` script **with no extension** (a Unix executable script; `deploy.sh` or `notes.py` aren't on Gmail's list, so they pass). That's the page's "messages that include executable files", checked on the bytes so a renamed `.exe` is caught.
- **Not checked:** malicious macros (Gmail decides; Terno can't tell malice), anything not on the page.

Where it runs, for accounts with `kind === "gmail"` only:

1. **When the user attaches** (`attachFilesNow`, picker, drop and paste): each file's name and first 64 KiB (archives: the whole file, within the 18 MiB limit) are checked before upload; a blocked file isn't attached and the snackbar says, in plain English: "Gmail won't send {name}: it doesn't allow {ext} files." / "…: it holds a file type Gmail doesn't allow." / "…: Gmail doesn't send password-protected archives." / "…: Gmail doesn't send programs." The other files attach.
2. **Before send** (`compose.send` and schedule): the backend runs the same check over the draft's assets (forwarded files never went through the picker); a blocked one refuses the send with the same message, and the draft stays as it is.
3. Changing the From account to Gmail with a blocked file already attached is caught by (2) at send.

**Size:** Terno's own limits already sit under Gmail's documented 25 MB for personal accounts (18 MiB of files, 25 MiB encoded message, `attachments.ts`), and a Workspace limit is the admin's to set (not knowable): kept, no Gmail-specific number added.

New strings (`en`, `es`): `attachments.gmailBlocked.type`, `.archive`, `.protected`, `.executable`.

### Tests

- `gmail-blocked.test.ts`: every listed extension (and upper case), a `.gz`/`.bz2` of one, a zip and a tgz holding one, a password-protected zip, a PE/ELF/Mach-O renamed `.pdf`, an extensionless shebang; passes for `report.pdf`, `deploy.sh` with a shebang, a zip of PDFs, a Java class file, `archive.tar.gz` of text.
- `apps/web/src/lib/attachments.test.ts`: a Gmail draft refuses `setup.exe` with the message and attaches the PDF beside it; an IMAP draft attaches both.
- Backend: `compose.send` on a Gmail account with a blocked asset is refused with the message; on IMAP it queues.
- e2e (`attachments.spec.ts`, one flow added to an existing scenario): attaching `tool.exe` to a Gmail draft shows the message and no chip.

---

## 7. Control 6.6.1: browser storage in the desktop renderer

> Tester: "it does not explicitly inventory IndexedDB or any other applicable browser storage mechanism … Explicitly state whether IndexedDB and every other applicable browser storage mechanism is used, and identify any confidential data or authentication material stored in each one."

### Inventory (code search; runtime check below)

The desktop renderer is `app://terno` in Electron's default session. Code that only the web build has (`VITE_TARGET === "web"`: `web/connect.ts`, `web/worker/*`, the service worker) is compiled out of the desktop bundle (`vite.config.ts`'s `desktopGuard`).

| Mechanism | Used on desktop | What | Confidential or auth material |
|---|---|---|---|
| localStorage | yes | UI preferences: `terno:appearance`, `terno:first-run`, `terno:language`, `terno:print` (print options), `terno:sidebar-more`, `terno:format-bar`, `terno:summaryOpen`, `terno.today.comingUp`, `terno.whatMatters.clearDays`, `terno:panes`, `terno:${tip}-tip`; per-account UI state: `terno:sidebar-account`, `terno:sidebar-solo` (account ids), `terno:people-filter` (account ids), `terno:list-filter` (account ids, folder names), `terno:palette-usage` (account, category, tab ids); `terno:learned-seen` (learned-rule proposals already shown: sender addresses, domains, list ids) | No authentication material (no token, password, key, cookie or session id). Mail-derived: folder names and, in `terno:learned-seen`, sender addresses |
| sessionStorage | yes | `terno:learned-hushed` (`"1"`) | none |
| IndexedDB | **no** (mailbox, keys and diagnostics databases are web-only; desktop diagnostics go to main over IPC) | — | — |
| Cache Storage | no (the service worker's cache is web-only) | — | — |
| Service workers | no (registered only by `web/connect.ts`) | — | — |
| Cookies | no (no `document.cookie`, no cookie API in main; nothing sets one on `app://`) | — | — |
| WebSQL | no | — | — |
| File System / OPFS / File System Access | no (OPFS is the web build's SQLite) | — | — |
| BroadcastChannel / Web Locks | no (web-only) | — | — |

The mailbox, drafts, credentials and tokens live in the backend's SQLite database and the OS keychain (safeStorage), never in renderer storage. The print window runs in its own `terno-print` partition, cleared after every job.

### Fix: removing an account clears what renderer storage holds of it

Today removal leaves the removed account's id and folder names in `terno:list-filter`, `terno:people-filter` and `terno:palette-usage`. `reconcileAccounts` (on the `accounts` event) now calls `forgetAccountsUi(gone)`: those entries for that account go; when the **last** account is removed, every mail-derived key (`terno:list-filter`, `terno:people-filter`, `terno:palette-usage`, `terno:learned-seen`, `terno:sidebar-*`, `terno:learned-hushed`) is cleared too, so a Terno with no account holds only preferences.

### Runtime check

A packaged smoke test (`packaged.smoke.ts`, the existing scenario: demo mailbox, temp profile, background) reads, from the renderer: `localStorage` keys, `sessionStorage` keys, `indexedDB.databases()`, `caches.keys()`, `navigator.serviceWorker.getRegistrations()`, `document.cookie`, `typeof openDatabase`, OPFS's root entries; and from main, `session.defaultSession.cookies.get({})`. It asserts every IndexedDB, cache, worker, cookie and OPFS list is empty, every localStorage key is in the inventory above, and no value matches the demo account's address, a token pattern or a password. The output is the evidence excerpt.

### Tests

- `apps/web/src/lib/account-ui-storage.test.ts`: removal of one account drops its entries and keeps the others'; removal of the last clears the mail-derived keys and keeps preferences.
- The smoke above.

---

## Performance and resources

- The MCP server costs nothing until an agent connects (one `McpServer` per connection, as before per process); the bridge is a ~40 KB process instead of a 96 MB Node runtime per agent session. No polling anywhere: the bridge blocks in `poll`, reconnects only when a request arrives.
- Secret access lines: folded reads, one unref'd timer only while a fold is open.
- Gmail checks: at attach, 64 KiB per file (archives: their directory or headers); at send, the draft's assets once.
- Sign-in lines: a handful per sign-in.

## Out of scope

- Windows (not built). Gmail accounts added over IMAP (`kind: "imap"` with Google's servers) get no blocked-type check: Terno doesn't know their provider for sure.
- Malicious macro detection.
- `adoptLegacyEnv`'s Única variable names in the bridge (no users from that era).
- 4.1.1, 4.1.2 (scan reports) and the portal: handled elsewhere.

## Revisions after the Codex review

Codex read the plan against the code (12 points). What changed:

1. **The refresh-token delete is fenced to the credential that was refused.** The backend does it from the refusal itself (`tokenResult`), not from a plaintext comparison: the provider context remembers the blob each `refreshToken` read came from; the delete is a compare-and-delete on exactly that blob (`secrets.remove(name, blob)`), and only while the account's credentials generation is still the refusal's (a sign-in since then bumps it, plan 264). `tokenResult` and the sign-in mark run first; a failed delete is logged (`secret.access`, `failed`) and changes nothing else (the account already asks for sign-in, and the next sign-in replaces the token). Identity's explicit renewal read (`identity.ts:165`) never deletes: it's a user action that ends in a sign-in anyway.
2. **Every credential and sign-in line is local-only, with fixed fields.** A `local` flag on a code keeps it out of the breadcrumb ring (so out of every error record and report) for the whole family: `secret.*`, `signin.*`, `token.refresh`, `imap.login`, `smtp.login`. No free-text request or response summary: each value is a typed field: `[redacted]`-only enums for anything secret (`code`, `codeVerifier`, `accessToken`, `refreshToken`, `idToken`, `user`), integers (`status`, `expiresIn`, `port`), enums (`tokenType`, `endpoint`, `pkce`, `grantType`), and the granted scopes as an enum list of known names (`scopes`, unknown ones as `other`). Tests serialize an export and a report.
3. **The bridge stays native, with the protocol details made exact** (Codex suggested a maintained MCP implementation outside Electron: that means a separate Node runtime, about 100 MB, which plan 283 already set aside). Ids are compared decoded (numbers by value, strings after unescaping), so a reply always settles its request; a `notifications/cancelled` settles the request it names; and a **tool call in flight when the connection drops** gets a message that says its outcome is unknown, not "try again": "Terno closed before answering, so this may or may not have happened. Open Terno and check before trying it again." (Today's server said "Can't reach Terno … try again" there, which could lead an agent to send twice.)
4. **The session's end can't hang.** Requests are tracked by id (a cancelled one leaves the set), the SDK transport gets a 64 MiB frame bound, and closing the socket for any reason (agent gone, rotation, agents off) closes the in-process RPC pair, so the backend drops the connection. Test: a call cancelled and then EOF ends the session.
5. **Gmail's check covers every way mail is queued**: `compose.send`, `compose.hold` (Undo Send) and `compose.schedule`, over exactly the sealed assets the request names (sealed assets don't change). Already queued mail isn't rescanned (no users yet).
6. **The helper's own signature is checked, in every copy users get.** It stays at `Resources/bin/terno-mcp` (the path every agent config already holds; Electron's signed native modules under `Resources/app.asar.unpacked` notarize the same way). `package.mjs` checks the built app's and the DMG's copy, `release.mjs build-mac` the app's and the update zip's: signed by the app's team, `flags=…runtime` and a secure timestamp on a Developer ID build, thin arm64, `codesign --verify --strict` on the helper itself.
7. **One wire error for crypto failures.** `SecretStorageError` is an `RpcError` (`UNAVAILABLE`, expected, `details: { category: "secret_storage_failed" }`, the catalog message `errors.secret.storage`), so the renderer gets that exact payload. The seam logs only `secret.failed` (code and op) and never calls `captureError` for it (which would keep frames). Tested through the real entry points: `accounts.addImap`, `ai.setKey`, reconnect, a provider read, the legacy migration.
8. **Writes and deletes are recorded after they commit.** Account creation (the secret goes in with the account), removal (the prefix delete), rotation (CAS) and AI keys record `write`/`delete` once the store call returns, `failed` if it threw; a seal that fails records `write`/`failed`. The fold and failure maps are bounded (256 keys each). The evidence describes folded reads as counted aggregates.
9. **Separate positive controls.** Stock Electron with `ELECTRON_RUN_AS_NODE=1 -e <marker>` writes the marker (the variable gives Node there), and with `NODE_OPTIONS=--require <probe>` runs the probe; Terno with both, `--remote-debugging-port=0` (and `--inspect=0` when shipped) prints its own refusal and exits 1 with neither file written.
10. **Linux: the helper's ABI and the packages' contents are checked.** `package-linux.mjs` checks each helper is an ELF of its architecture, executable, and that its `GLIBC_` needs are no newer than Electron's own binary's; `release.mjs build-linux` checks the helper inside every deb and rpm (present, executable, right architecture). The CJS bundle leaves the file list.
11. **Archive inspection is bounded and never guesses.** At most 18 MiB read (the attachment limit), 10,000 entries, a malformed or unreadable archive is "couldn't inspect" and **allowed** (Gmail decides; Terno only refuses what the page names). The attach batch keeps its inline images' content ids: a blocked file is removed before ids are assigned. Attaching isn't a hot path (once per file, bounded), so no perf gate. `pnpm test:all` runs for the store contract change.
12. **Storage cleanup covers the legacy key and the live state.** `terno:unread-filter` (legacy, read once) is in the inventory and is cleared with the others; the learned-offer module's in-memory set is reset with its key, so it can't write it back. The packaged smoke seeds known values under two accounts, removes one, then the other, and checks what's left.
