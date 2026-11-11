#!/usr/bin/env bash
# Launch a demo build of the desktop app with its own profile and Vite port.
#   ./run.sh demo     demo mailbox        (/tmp/terno-demo,    port 5412)
#   ./run.sh demoai   demo mailbox + AI   (/tmp/terno-demo-ai, port 5442)
set -euo pipefail

cd "$(dirname "$0")"
# Electron must start as Electron, not as Node (AGENTS.md).
unset ELECTRON_RUN_AS_NODE

case "${1:-}" in
  demo)
    TERNO_USER_DATA=/tmp/terno-demo TERNO_VITE_PORT=5412 exec pnpm dev:desktop:demo
    ;;
  demoai)
    TERNO_USER_DATA=/tmp/terno-demo-ai TERNO_VITE_PORT=5442 exec pnpm dev:demo-ai
    ;;
  *)
    echo "usage: $0 demo|demoai" >&2
    exit 1
    ;;
esac
