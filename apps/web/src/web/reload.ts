import { t } from "@terno/i18n";
import { draftsSaved } from "~/lib/drafts";
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

export async function whenDraftsSaved(go: () => void, deps: WhenSavedDeps = live): Promise<boolean> {
  if (await deps.saved()) {
    go();
    return true;
  }
  deps.warn({ retry: () => void whenDraftsSaved(go, deps), anyway: go });
  return false;
}
