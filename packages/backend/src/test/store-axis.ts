import { it } from "vitest";

const unused = Object.assign(() => {}, { each: () => () => {} }) as unknown as typeof it;

/**
 * A backend flow repeats across the stores only where the store decides what it asserts: a commit or its rollback, a
 * row durable across a reopen, a fence checked inside a store command. What the provider or the backend decides over a
 * store's answers is already pinned to the same answers by the store contract (`@terno/store/conformance`), so it runs
 * on SQLite once: `const sqlite = onSqlite(kind)`, then `sqlite(...)` in place of `it(...)`.
 */
export const onSqlite = (kind: string): typeof it => (kind === "SQL" ? it : unused);
