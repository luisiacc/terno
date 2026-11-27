#!/usr/bin/env bash
# Launch a demo build of the desktop app with its own profile and Vite port.
#   ./run.sh demo     demo mailbox        (/tmp/terno-demo,    port 5412)
#   ./run.sh demoai   demo mailbox + AI   (dev:demo-ai's own profile, port 5430)
#   ./run.sh personal your own accounts    (/tmp/terno-personalme, port 5423)
set -euo pipefail

cd "$(dirname "$0")"
# Electron must start as Electron, not as Node (AGENTS.md).
unset ELECTRON_RUN_AS_NODE

case "${1:-}" in
  demo)
    TERNO_USER_DATA=/tmp/terno-demo TERNO_VITE_PORT=5412 exec pnpm dev:desktop:demo
    ;;
  personal)
    TERNO_USER_DATA=~/.local/terno-personal TERNO_VITE_PORT=5423 exec pnpm dev:desktop
    ;;
  demoai)
    # not /tmp: macOS clears old files there, and a profile that lost its demo-ai.json is refused (plan 167)
    TERNO_USER_DATA=~/.local/terno-demo-ai TERNO_VITE_PORT=5430 exec pnpm dev:demo-ai
    ;;
  *)
    echo "usage: $0 demo|demoai|personal" >&2
    exit 1
    ;;
esac
