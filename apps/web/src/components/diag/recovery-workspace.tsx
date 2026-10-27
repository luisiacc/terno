import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { TooltipProvider } from "@terno/ui/components/tooltip";
import { useEffect, useRef } from "react";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { draftPresentationThread, useDrafts, validBodyCheckpoint } from "~/lib/drafts";
import { useApp } from "~/state/app";
import { DraftSlot } from "../inline-draft";
import { focusBody } from "../composer/controller";

/** Opened only by Review drafts; all authored fields/history stay in their original writer. */
export function RecoveryWorkspace() {
  const requested = useDraftRecovery((s) => s.key);
  const reason = useDraftRecovery((s) => s.reason);
  const checkpoint = useDraftRecovery((s) => s.checkpoint);
  const drafts = useDrafts((s) => s.drafts);
  const accounts = useApp((s) => s.accounts);
  const key = checkpoint ? requested : requested && drafts[requested] ? requested : Object.keys(drafts)[0] ?? null;
  const d = key ? drafts[key] : undefined;
  const valid = !checkpoint || (key === checkpoint.key && validBodyCheckpoint(checkpoint));
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!key || !valid) return;
    const active = document.activeElement;
    let disposed = false;
    const cancel = focusBody(key, "keep", (cancelPending) => {
      const ownBody = (node: EventTarget | null) => node instanceof Element && Boolean(rootRef.current?.contains(node)) && Boolean(node.closest('[data-testid="compose-body"], [data-testid="compose-body-loading"]'));
      const moved = (event: FocusEvent) => {
        if (event.target !== document.body && !ownBody(event.target)) cancelPending();
      };
      if (disposed || (document.activeElement !== active && document.activeElement !== document.body && !ownBody(document.activeElement))) { cancelPending(); return () => {}; }
      document.addEventListener("focusin", moved, true);
      return () => document.removeEventListener("focusin", moved, true);
    });
    return () => { disposed = true; cancel(); };
  }, [key, valid]);
  return <TooltipProvider>
    <main ref={rootRef} className="flex h-screen flex-col bg-background text-foreground" data-testid="recovery-workspace" aria-label={t("recovery.reload.review")}>
      <header className="hairline-b flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1"><h1 className="font-semibold">{t("recovery.reload.review")}</h1><p className="text-sm text-muted-foreground">{t(reason === "reload" ? "recovery.reload.held" : "recovery.reload.offline")}</p></div>
        <Button variant="outline" data-testid="recovery-details" onClick={() => useDraftRecovery.setState({ open: false, checkpoint: undefined })}>{t(reason === "reload" ? "recovery.reload.back" : "recovery.reload.showError")}</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-(--reader-pad-x) pb-8">
        <div className="mx-auto max-w-(--reader-max)">
          <label className="mt-4 flex items-center gap-3 text-sm">{t("compose.strip.label")}
            <select className="min-w-0 flex-1 rounded-md bg-background p-2 text-foreground" value={key ?? ""} disabled={Boolean(checkpoint)} onChange={(e) => useDraftRecovery.setState({ key: e.target.value })}>
              {Object.values(drafts).map((draft) => <option key={draft.key} value={draft.key}>{draft.subject || t("compose.untitled")}</option>)}
            </select>
          </label>
          {!valid && <p role="alert">{t("recovery.reload.unsaved")}</p>}
          {valid && d && <DraftSlot threadId={draftPresentationThread(d) ?? 0} draftKey={d.key} replyTo="" account={accounts.find((a) => a.id === d.accountId)} checkpoint={checkpoint} />}
        </div>
      </div>
    </main>
  </TooltipProvider>;
}
