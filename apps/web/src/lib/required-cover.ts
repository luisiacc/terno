import { useEffect, useState } from "react";
import { draftsSaved, useDrafts } from "~/lib/drafts";
import { useUpdates } from "~/lib/updates";

/**
 * Plan 95: whether the required-update screen may cover the window now. It
 * never covers unsaved work: while a draft isn't saved as written the app
 * stays usable (the sidebar pill says "Update Required"), and it covers once
 * every draft is saved. Driven by the drafts' own changes, at most once a
 * second while someone types; nothing runs on a timer otherwise.
 */
export function useRequiredCover(): boolean {
  const required = useUpdates((s) => s.state?.required ?? null);
  // an install refused because of unsaved drafts uncovers the window until they're saved
  const unsaved = useUpdates((s) => s.state?.error?.kind === "unsaved");
  const [clear, setClear] = useState(false);
  useEffect(() => {
    setClear(false);
    if (!required) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let checking = false;
    const check = () => {
      timer = null;
      if (checking) return;
      checking = true;
      void draftsSaved(1000)
        .then((ok) => alive && setClear(ok))
        .finally(() => (checking = false));
    };
    check();
    const stop = useDrafts.subscribe(() => {
      if (alive && !timer) timer = setTimeout(check, 1000);
    });
    return () => {
      alive = false;
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [required, unsaved]);
  return required !== null && clear;
}
