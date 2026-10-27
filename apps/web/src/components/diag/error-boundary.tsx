import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Component, lazy, Suspense, useLayoutEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { RecoveryReload } from "./recovery-reload";
import { captureUi } from "~/lib/diag";
import { exposeForTests } from "~/lib/render-probe";
import { exportDiagnostics } from "~/state/diag";
import { registerReaderPaneFailure } from "~/lib/compose";

type Area = "app" | "reader" | "settings";

interface Props {
  area: Area;
  /** a change (another thread, another tab) gives the area a fresh try */
  resetKey?: unknown;
  fallback: (o: { id: string | null; reset: () => void }) => ReactNode;
  children: ReactNode;
}

/**
 * Catches a render error in its area and records it (ui.boundary): one
 * broken mail or settings section can't take the whole window down.
 */
class Boundary extends Component<Props, { failed: boolean; id: string | null }> {
  override state = { failed: false, id: null as string | null };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // React retries a failed render once: the second capture folds into the first and returns its id
    const id = captureUi(error, { code: "ui.boundary", fields: { area: this.props.area } });
    if (id) this.setState({ id });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    testThrow.setState({ area: null });
    this.setState({ failed: false, id: null });
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback({ id: this.state.id, reset: this.reset }) : this.props.children;
  }
}

/** Test builds: `__terno.throwIn("reader")` makes that area throw while rendering. */
const testThrow = create<{ area: Area | null }>(() => ({ area: null }));
exposeForTests({ throwIn: (area: Area) => testThrow.setState({ area }) });

export function TestThrow({ area }: { area: Area }) {
  const armed = testThrow((s) => (import.meta.env.VITE_RENDER_PROBE ? s.area === area : false));
  if (armed) throw new Error(`test: ${area} threw while rendering`);
  return null;
}

const shortId = (id: string) => id.slice(0, 8);

const RecoveryWorkspace = lazy(() => import("./recovery-workspace").then((m) => ({ default: m.RecoveryWorkspace })));
export function RecoveryBoundary({ children }: { children: ReactNode }) {
  return <Boundary area="app" fallback={() => <main className="flex h-screen flex-col items-center justify-center gap-3" data-testid="recovery-unavailable">
    <p role="alert">{t("recovery.reload.unsaved")}</p>
    <Button variant="outline" onClick={() => useDraftRecovery.setState({ open: false, checkpoint: undefined })}>{t("recovery.reload.showError")}</Button>
  </main>}>{children}</Boundary>;
}
function AppFallback({ id }: { id: string | null }) {
  const recovering = useDraftRecovery((s) => s.open);
  if (recovering) return <RecoveryBoundary><Suspense><RecoveryWorkspace /></Suspense></RecoveryBoundary>;
  return (
    <main className="flex h-screen items-center justify-center bg-background p-10 text-center" data-testid="app-boundary">
      <div role="alert" className="max-w-sm">
        <h1 className="text-md font-semibold tracking-tight">{t("app.boundary.title")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("app.boundary.body")}</p>
        <div className="mt-5 flex flex-col items-center gap-2">
          <RecoveryReload testId="app-boundary-reload" label="app.boundary.reload" />
          <Button variant="outline" data-testid="app-boundary-export" onClick={() => void exportDiagnostics()}>{t("diag.exportButton")}</Button>
        </div>
        {id && <p className="mt-6 text-xs text-muted-foreground tabular-nums select-text">{t("app.boundary.reference", { id: shortId(id) })}</p>}
      </div>
    </main>
  );
}

/** The whole window: a calm screen, a reload, and the diagnostics to send if it keeps happening. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      area="app"
      fallback={({ id }) => <AppFallback id={id} />}
    >
      <TestThrow area="app" />
      {children}
    </Boundary>
  );
}

const PANE_TITLE = { reader: "app.boundary.reader", settings: "app.boundary.settings" } as const;

function ReaderFailure({ threadId, children }: { threadId: unknown; children: ReactNode }) {
  const failedThread = useRef(threadId).current;
  const token = useRef({}).current;
  useLayoutEffect(() => typeof failedThread === "number" ? registerReaderPaneFailure(failedThread, token) : undefined, [failedThread, token]);
  return children;
}

/** One pane (the reader, a settings section): the rest of the window keeps working. Its title follows the area unless given. */
export function PaneBoundary({ area, resetKey, readerThreadId, title, children }: { area: keyof typeof PANE_TITLE; resetKey?: unknown; readerThreadId?: number | null; title?: string; children: ReactNode }) {
  return (
    <Boundary
      area={area}
      resetKey={resetKey}
      fallback={({ id, reset }) => {
        const content = (
        <div role="alert" className="flex h-full min-h-48 items-center justify-center p-8 text-center" data-testid={`${area}-boundary`}>
          <div className="max-w-xs">
            <p className="text-sm font-medium">{title ?? t(PANE_TITLE[area])}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("app.boundary.saved")}</p>
            <Button size="sm" variant="outline" className="mt-3.5" data-testid={`${area}-boundary-retry`} onClick={reset}>
              {t("app.tryAgain")}
            </Button>
            {id && <p className="mt-4 text-xs text-muted-foreground tabular-nums select-text">{t("app.boundary.reference", { id: shortId(id) })}</p>}
          </div>
        </div>
        );
        return area === "reader" ? <ReaderFailure threadId={readerThreadId}>{content}</ReaderFailure> : content;
      }}
    >
      <TestThrow area={area} />
      {children}
    </Boundary>
  );
}
