import { t } from "@terno/i18n";
import { acquireDraftHold, draftsSaved } from "~/lib/drafts";
import { snack } from "~/lib/snack";

/**
 * A new web build drops the page (activating it, or reloading into it). It
 * happens only once every draft is saved as written; a save that's slow or
 * failing holds it, says so, and leaves the choice to the user: try again,
 * or go ahead anyway (losing only what the snack warned about).
 */
export interface WhenSavedDeps {
  saved(): Promise<boolean>;
  warn(o: { retry: () => void; anyway: () => void }): void;
}

const live: WhenSavedDeps = {
  saved: () => draftsSaved(),
  warn: ({ retry, anyway }) =>
    snack.error(t("updates.reload.title"), {
      id: "update-reload",
      description: t("updates.reload.body"),
      duration: 30_000,
      action: { label: t("updates.tryAgain"), onClick: retry },
      secondary: { label: t("updates.reload.anyway"), name: t("updates.reload.anywayName"), onClick: anyway },
    }),
};

let pending: Promise<boolean> | null = null;
let attempt = 0, navigating = false;

/** An async commit owns admission until it settles; navigation keeps its lease through unload. */
export function whenDraftsSaved(go: () => unknown | Promise<unknown>, deps: WhenSavedDeps = live, options: { navigation?: boolean } = {}): Promise<boolean> {
  if (navigating) return Promise.resolve(true);
  if (pending) return pending;
  const token = ++attempt;
  const release = acquireDraftHold();
  const warn = () => deps.warn({
    retry: () => { if (token === attempt) void whenDraftsSaved(go, deps, options); },
    anyway: () => { if (token === attempt) void go(); },
  });
  const run = async () => {
    if (!release) { warn(); return false; }
    let committed = false;
    try {
      if (!await deps.saved()) { release(); warn(); return false; }
      if (options.navigation) navigating = true;
      await go();
      committed = Boolean(options.navigation);
      return true;
    } finally {
      if (!committed) { navigating = false; release(); }
    }
  };
  pending = run().finally(() => { pending = null; });
  return pending;
}
