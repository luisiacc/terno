import { RecoveryReload } from "~/components/diag/recovery-reload";
import { t, type TextKey } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { requestTakeover, takeBack } from "./connect";
import { showText, useWeb, type WebLifecycle } from "./lifecycle";

/**
 * A blocking screen: a modal dialog over the whole page. It takes focus (its
 * button, or itself), the app behind it is inert (nothing focusable or
 * clickable, its shortcuts suspended) until it goes away.
 */
function Screen({ title, body, children, testId }: { title: string; body?: React.ReactNode; children?: React.ReactNode; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const root = document.getElementById("root");
    if (root) root.inert = true;
    const first = ref.current?.querySelector<HTMLElement>("button:not([disabled])");
    (first ?? ref.current)?.focus();
    return () => {
      if (root) root.inert = false;
    };
  }, [testId]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-10 text-center outline-none"
      data-testid={testId}
    >
      <div className="max-w-md">
        {/* a full-window state still says which app it is; named, since not every title says "Terno" */}
        <TernoMark label="Terno" className="mx-auto mb-4 size-8 text-muted-foreground" data-testid="gate-mark" />
        <p id={titleId} className="font-semibold">
          {title}
        </p>
        {body && (
          <div id={bodyId} className="mt-1.5 text-sm text-muted-foreground">
            {body}
          </div>
        )}
        {children && <div className="mt-4 flex justify-center gap-2">{children}</div>}
      </div>
    </div>,
    document.body,
  );
}

const FATAL_TITLE = {
  SCHEMA_NEWER: "web.gate.stale.title",
  BUILD_MISMATCH: "web.gate.stale.title",
  UNAVAILABLE: "web.gate.unavailable.title",
  OPEN_FAILED: "web.gate.openFailed.title",
  CRASHED: "web.gate.crashed.title",
} as const satisfies Record<NonNullable<WebLifecycle["code"]>, TextKey>;

/**
 * The web's lifecycle over the app: one tab owns the mailbox at a time, a
 * newer build takes over cleanly, and an open error never swaps the mailbox
 * for an empty one (it says so and offers to retry).
 */
export function WebGate() {
  const { phase, progress, code, message } = useWeb();
  if (phase === "starting" && progress) {
    return (
      <Screen testId="web-starting" title={showText(progress)}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </Screen>
    );
  }
  if (phase === "elsewhere" || phase === "taking-over") {
    return (
      <Screen testId="web-elsewhere" title={t("web.gate.elsewhere.title")} body={t("web.gate.elsewhere.body")}>
        <Button data-testid="web-use-here" disabled={phase === "taking-over"} onClick={() => requestTakeover()}>
          {phase === "taking-over" && <Loader2 className="animate-spin" />} {t("web.gate.useHere")}
        </Button>
      </Screen>
    );
  }
  if (phase === "taken") {
    return (
      <Screen testId="web-taken" title={t("web.gate.taken.title")} body={t("web.gate.taken.body")}>
        <Button data-testid="web-take-back" onClick={takeBack}>
          {t("web.gate.useHere")}
        </Button>
      </Screen>
    );
  }
  if (phase === "fatal") {
    const stale = code === "SCHEMA_NEWER" || code === "BUILD_MISMATCH";
    return (
      <Screen
        testId="web-fatal"
        title={t(FATAL_TITLE[code ?? "OPEN_FAILED"])}
        body={
          <>
            <p>{stale ? t("web.gate.stale.body") : t("web.gate.kept")}</p>
            {message && !stale && <p className="mt-2 font-mono text-xs break-words">{showText(message)}</p>}
          </>
        }
      >
        <RecoveryReload testId="web-reload" label={stale ? "web.gate.reload" : "common.retry"} />
      </Screen>
    );
  }
  // a newer build waiting ("New version · Reload") is the sidebar's update pill
  return null;
}
