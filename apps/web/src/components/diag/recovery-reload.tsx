import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useRef, useState } from "react";
import { draftsSaved } from "~/lib/drafts";
import { reviewDrafts } from "~/lib/draft-recovery-ui";
import { whenDraftsSaved } from "~/web/reload";

/** Fatal fallbacks own their warning: the normal snack/app may be inert or unmounted. */
export function RecoveryReload({ testId, label }: { testId: string; label: "web.gate.reload" | "common.retry" | "app.boundary.reload" }) {
  const [warned, setWarned] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const reload = async () => {
    if (active.current) return;
    active.current = true; setBusy(true);
    try { await whenDraftsSaved(() => location.reload(), { saved: () => draftsSaved(), warn: () => setWarned(true) }, { navigation: true }); }
    finally { active.current = false; setBusy(false); }
  };
  return (
    <div className="flex flex-col items-center gap-3">
      {warned && <p role="alert" className="text-sm text-muted-foreground" data-testid="recovery-reload-warning">{t("recovery.reload.unsaved")}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        <Button data-testid={testId} onClick={() => void reload()} aria-disabled={busy} aria-busy={busy}>{t(label)}</Button>
        {warned && <>
          <Button variant="outline" data-testid="recovery-review" onClick={() => reviewDrafts()}>{t("recovery.reload.review")}</Button>
          <Button variant="outline" data-testid="recovery-force" aria-label={t("recovery.reload.anywayName")} onClick={() => location.reload()}>{t("updates.reload.anyway")}</Button>
        </>}
      </div>
    </div>
  );
}
