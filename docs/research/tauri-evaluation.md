# Tauri evaluation for Terno

Date: 2026-10-29. Evaluation only; no runtime changes or comparative benchmark.

Supporting API research: [primary-source notes](tauri-primary-sources.md).

Request: “evaluate using tauri here instead of electron, what benefits we would get and what would we loose?”

## Recommendation

Keep Electron for the current product. Tauri is worth a bounded prototype if download/install size or measured whole-app resource usage becomes a priority. The practical first candidate is **Tauri + the existing TypeScript backend in a bundled Node sidecar**, preserving the React renderer and native SQLite. A Rust backend rewrite has substantially higher scope and would surrender much of the desktop/web backend sharing.

This is a judgment based on the existing architecture and the documented API differences below. Tauri has not been built or benchmarked with Terno, so there is no evidence yet for a particular memory, battery, startup, or final bundle-size improvement.

## What exists

- [Desktop host](../../apps/desktop/src/app.ts): Electron owns windows, appearance, menus, notifications, wake/network events, secret encryption, engine supervision and coordinated shutdown. The backend runs in `utilityProcess.fork`. A transferred `MessageChannelMain` connects the renderer directly to it; mailbox traffic bypasses main.
- [Backend host](../../apps/desktop/src/backend-entry.ts): mostly reusable services and providers, but its entry protocol uses Electron's `process.parentPort` and transferred ports. It delegates the `SecretCipher` to main's `safeStorage`.
- [Node database driver](../../packages/db/src/node-driver.ts): `node:sqlite`, filesystem operations, WAL checkpoint workers and durability tuning. [Incoming processing](../../packages/backend/src/incoming-worker.ts) uses `worker_threads`, transferable buffers and worker memory limits.
- [Mail registry](../../packages/mail/src/registry.ts): IMAP through ImapFlow, SMTP through Nodemailer, plus desktop Gmail OAuth. [MCP launcher](../../apps/desktop/resources/bin/terno-mcp) uses Electron's bundled Node in RunAsNode mode; it also needs a replacement runtime/launcher.
- [Renderer connection](../../apps/web/src/rpc/connection.ts): an existing transport interface and typed RPC make an additional host feasible, but Electron's direct MessagePort transport is not automatically preserved by Tauri.
- The portable backend/store seams and web worker already exist. [Plan 04](../plans/04-storage-and-web.md) explains their design. The web target is deliberately Gmail-only and has browser-storage durability; wrapping it alone would lose desktop IMAP/SMTP, MCP and existing native persistence behavior. Those are limitations of that shortcut, not inherent Tauri limitations.
- Both [renderer](../../apps/web/playwright.config.ts) and [web](../../apps/web/playwright.web.config.ts) E2E configurations currently select Desktop Chrome. [Packaged desktop tests](../../apps/desktop/e2e/packaged.smoke.ts) use Playwright's `_electron` launcher and main-process evaluation.

The existing local `apps/desktop/release/mac-arm64/Terno.app` occupies approximately **254 MiB**, its `Contents/Frameworks` **243 MiB**, and its `Resources/app.asar` **8.3 MiB**, measured using `du -sh`. These are filesystem usage readings of an existing artifact, not compressed download sizes, memory readings, or a fresh build of this checkout. The frameworks include Electron's browser/runtime machinery; they are not all removable without replacement because Terno still needs a JavaScript backend runtime.

## Benefits and costs

| Area | Potential benefit | Cost or qualification for Terno |
| --- | --- | --- |
| Distribution | Remove the bundled Chromium engine; likely a substantially smaller installed app and full downloads. | Ship Node and our backend/worker assets; do not apply minimal Tauri demo sizes to this product. Update bandwidth must be measured against the existing updater and its blockmap behavior. |
| Memory/startup | A smaller Rust shell and system WebView may improve baseline footprint and startup. | WKWebView still has web-content/network/GPU processes. Node, SQLite caches, search indexes, parsed mail and React remain. No percentage savings or battery claim is established. |
| Security maintenance | An explicit capability model for native APIs; the OS supplies the browser engine. | Existing Electron already uses sandboxing, context isolation, no renderer Node, CSP and a narrow preload. Tauri is not automatically more private. We would maintain Rust/Tauri and the separately bundled Node runtime, while WebKit updates follow the OS. |
| Rendering | The React/Vite renderer can largely remain. | macOS moves from Chromium/V8 to WKWebView/WebKit/JavaScriptCore. Retest ProseMirror selection, IME, paste, undo, spellcheck, huge-draft `content-visibility`, iframe sizing, accessibility, keyboard focus, drag behavior and performance. Windows and Linux add different engine/version combinations. |
| Native feel | Native menus, dialogs and window integration remain possible. | The UI remains HTML/CSS. Premium appearance is already implemented and will not improve automatically. Reimplement and verify window appearance, menu roles, notification click routing and lifecycle behavior. |
| Backend sharing | A Node sidecar keeps most TypeScript domain logic, providers, SQL and tests. | Add a Rust host, secure IPC, sidecar lifecycle/signing and a separately pinned Node runtime. This preserves two implementation languages in the desktop host. |
| Testing | Existing pure services, stores and much browser coverage remain useful. | Port Electron-specific packaged tests and establish WKWebView performance/visual baselines. Current Tauri documentation supports macOS via WebdriverIO's embedded driver; the upstream standalone `tauri-driver` path still lacks macOS support. |
| Mobile | Tauri supports mobile platforms as a future shell option. | Desktop Node sidecars and macOS integrations do not become a mobile mail backend automatically. It does not replace the static web build either. |

Sources: [Tauri architecture](https://v2.tauri.app/concept/architecture/), [WebView engines and updates](https://v2.tauri.app/reference/webview-versions/), [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [external binary packaging](https://v2.tauri.app/develop/sidecar/), [capabilities](https://v2.tauri.app/security/capabilities/), [current WebDriver guide](https://v2.tauri.app/develop/tests/webdriver/). Benefits described as “may” or “likely” are architectural inferences, not Terno measurements.

## Migration gates

1. **Preserve local-mode enforcement.** [The current network backstop](../../apps/desktop/src/network-backstop.ts) uses Electron request resource types and frame ancestry to allow images from mail frames while blocking app-frame images, fetches, sockets and other requests. Consent itself remains in renderer/CSP policy. Tauri's documented [`on_web_resource_request`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html#method.on_web_resource_request) currently handles its own protocol, not arbitrary remote HTTP requests. Its capabilities govern IPC/native commands, not all WebView egress. Equivalent enforcement requires a proved WebKit/native design, potentially content rules or a controlled resource-loading path. Do not simply remove this fence or weaken the local-mode promise. Never give untrusted mail frames native API access. The capability docs also warn that Linux/Android cannot distinguish embedded iframe API requests from their containing window.
2. **Prove packaged Node compatibility.** Preserve `node:sqlite`, its SQLite/FTS capabilities, filesystem durability, checkpoint workers, incoming worker assets/limits, DNS policy, provider connections and the MCP launcher. Tauri's sidecar guide demonstrates packaging JavaScript but does not validate this dependency graph. Replacing `process.parentPort` and the renderer bridge must retain subscriptions, reconnect behavior, validation, throughput and bounded large-attachment handling. A Rust relay over pipes is one candidate; a loopback server is not required by Tauri and should not be introduced casually.
3. **Preserve printing/PDF behavior.** [Current printing](../../apps/desktop/src/print.ts) uses a separate ephemeral session/window with JavaScript disabled, explicit remote-image allowlists, Chromium PDF options, atomic exports and cleanup. Tauri [supports a print dialog](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html#method.print); that is not a drop-in implementation of this PDF/export/privacy pipeline. Prototype native WKWebView PDF/print integration and pagination, metadata, cancellation and cleanup before claiming parity.
4. **Plan credential and profile migration.** Existing blobs are Electron `safeStorage` ciphertext backed by app-named Keychain entries; [an earlier app rename already needed a migration helper](../../apps/desktop/src/keychain-helper.ts). A Keychain or Stronghold API alone does not decode these blobs. Design a compatible transition or staged export/reseal in-process, verify new ciphertext before replacement, preserve pending failures and avoid unplanned account reauthentication. Keep the existing SQLite/profile identity and deliberate UI preference migration; WebView-origin storage does not transfer automatically. Use synthetic profiles and credentials exclusively for evaluation.
5. **Preserve shutdown and updates.** Carry over draft flush/leases, reload refusal, send-in-flight handling, crash supervision, closed-window sync and notification routing. The [Tauri updater](https://v2.tauri.app/plugin/updater/) has a different signed artifact/feed format. Preserve explicit update consent/local mode, signing/notarization, and migration from already-installed Electron versions; an existing updater will not automatically discover a new artifact format.

## Options

| Option | Reuse | Assessment |
| --- | --- | --- |
| Keep Electron | Current product, tooling and tests | Recommended default; establish whole-app resource baselines first. |
| Tauri + Node sidecar | React, TypeScript backend, providers, native SQLite and domain tests | Most credible prototype. Meaningful host/IPC/privacy/release work remains. |
| Tauri + Rust backend | React, contracts and potentially schema/algorithm designs | Major migration. Port provider semantics, storage transactions, scheduling, search, MIME and safety behavior; shared web services would diverge unless deliberately redesigned. |
| Tauri wrapping the current web target | React and portable worker backend | Useful only as a limited experiment; it does not meet current desktop feature/storage parity. |

## Prototype acceptance evidence

Use matched release builds, the same Mac and synthetic mailbox data at 10k and 50k+ threads. Separate seeded-first-run time from a normal existing-mailbox cold start. Compare compressed download and installed size; whole-app memory including all browser/Node helper processes; cold/warm startup; idle CPU/wakeups and energy; sync/import CPU/peak memory; search/list latency; and huge-draft typing/paste/save. Account for shared process memory rather than treating one main-process RSS value as the app.

Before a switch, demonstrate the privacy fence, hostile mail isolation, actual print/PDF output, synthetic Keychain migration, attachment round trips, exact undo, draft recovery, send-safe shutdown, backend crash/reconnect, wake recovery, closed-window sync, notification clicks and a signed Electron-to-Tauri update. Inspect light/dark screenshots and native accessibility. Keep the existing web build and conformance/performance gates.

Advance only if the measured savings justify the added platform and maintenance costs without weakening Terno's UX, privacy or durability contracts. This research does not authorize or perform that migration.
