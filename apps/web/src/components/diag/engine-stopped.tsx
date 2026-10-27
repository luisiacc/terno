import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Loader2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { registerNativeReloadModal } from "~/lib/native-reload";
import { exportDiagnostics, restartEngine, useDiag } from "~/state/diag";

/**
 * Desktop: the backend died five times in a row and main stopped restarting
 * it. The window can't work without it: say so plainly, keep the mail's
 * safety in front, and let the user try again (or export what happened).
 */
export function EngineStopped() {
  const engine = useDiag((s) => s.view?.engine ?? "running");
  const reviewing = useDraftRecovery((s) => s.open);
  const [retrying, setRetrying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const stopped = engine === "stopped" && !reviewing;
  useLayoutEffect(() => {
    if (!stopped) {
      setRetrying(false);
      return;
    }
    const release = registerNativeReloadModal(ref.current!, document.getElementById("root"));
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return release;
  }, [stopped]);
  if (!stopped) return null;
  return createPortal(
    <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-10 text-center backdrop-blur-md" data-testid="engine-stopped">
      <div className="max-w-sm">
        <p id={titleId} className="text-md font-semibold tracking-tight">
          {t("diag.engine.title")}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("diag.engine.body")}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button
            data-testid="engine-retry"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void restartEngine();
            }}
          >
            {retrying && <Loader2 className="animate-spin" />} {t("app.tryAgain")}
          </Button>
          <Button variant="outline" onClick={() => void exportDiagnostics()}>
            {t("diag.exportButton")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
