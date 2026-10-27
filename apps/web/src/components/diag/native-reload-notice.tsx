import { t } from "@terno/i18n";
import { useModalHost } from "@terno/ui/components/modal-host";
import { Button } from "@terno/ui/components/button";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { reviewDrafts } from "~/lib/draft-recovery-ui";
import { useNativeReload } from "~/lib/native-reload";

/** A fatal app or a recovery editor must not hide the native reload warning. */
export function NativeReloadNotice() {
  const anyway = useNativeReload((s) => s.anyway);
  const fatalHost = useNativeReload((s) => s.modalHost);
  const healthyHost = useModalHost();
  const host = fatalHost ?? healthyHost;
  const focusTarget = useNativeReload((s) => s.focusTarget);
  const ref = useRef<HTMLElement>(null), previousFocus = useRef<HTMLElement | null>(null), opened = useRef(false);
  useLayoutEffect(() => {
    if (anyway && !opened.current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!anyway) previousFocus.current = null;
    opened.current = Boolean(anyway);
  }, [anyway]);
  useLayoutEffect(() => {
    if (!focusTarget) return;
    if (anyway && document.activeElement === document.body) ref.current?.querySelector<HTMLElement>(`[data-testid="${focusTarget}"]`)?.focus({ preventScroll: true });
    useNativeReload.setState({ focusTarget: null });
  }, [host, focusTarget, anyway]);
  if (!anyway) return null;
  const dismiss = () => useNativeReload.setState({ anyway: null });
  const notice = <aside ref={ref} aria-label={t("updates.reload.title")} data-testid="native-reload-notice" className="fixed bottom-6 left-1/2 z-100 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-xl bg-background p-4 text-foreground shadow-lg ring-1 ring-border">
    <div role="alert"><p className="text-sm font-semibold">{t("updates.reload.title")}</p><p className="mt-1 text-sm text-muted-foreground">{t("recovery.reload.unsaved")}</p></div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button data-testid="native-reload-review" onClick={() => { dismiss(); reviewDrafts("reload"); }}>{t("recovery.reload.review")}</Button>
      <Button variant="outline" data-testid="native-reload-anyway" aria-label={t("recovery.reload.anywayName")} onClick={() => { dismiss(); anyway(); }}>{t("updates.reload.anyway")}</Button>
      <Button variant="ghost" data-testid="native-reload-close" onClick={(event) => {
        const owned = document.activeElement === event.currentTarget;
        const prior = previousFocus.current;
        dismiss();
        if (owned) (prior?.isConnected && !prior.closest('[inert], [aria-hidden="true"]') && (!host || host.contains(prior)) ? prior : host?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
      }}>{t("common.close")}</Button>
    </div>
  </aside>;
  return host ? createPortal(notice, host) : notice;
}
