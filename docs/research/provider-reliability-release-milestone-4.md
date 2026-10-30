# Fourth provider-reliability release milestone

Announced 2026-10-30 after supported huge-editor view grouping landed. Run all required gates once, serially, on the recorded clean main commit: typecheck, lint, unit plus WASM, E2E, standalone Web, UI performance, backend performance, macOS package and fresh default packaged smoke. Preserve native runner deadlines, workloads, budgets and existing skips; report failures and not-run cases separately. No retries seeking green.

Preserve earlier milestone logs and generated outputs. Use synthetic providers and temporary profiles only, the inherited network guard, distinct ports, captured owned process identities and fresh package hashes. Default native tracing and development overrides remain unset. No source/HEAD changes during this run. Root will record the actual result and repair remaining failures in isolated worktrees.
