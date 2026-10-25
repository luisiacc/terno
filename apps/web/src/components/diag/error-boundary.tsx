import { Button } from "@terno/ui/components/button";
import { Component, type ReactNode } from "react";
import { create } from "zustand";
import { captureUi } from "~/lib/diag";
import { exposeForTests } from "~/lib/render-probe";
import { exportDiagnostics } from "~/state/diag";

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

const shortId = (id: string | null) => (id ? id.slice(0, 8) : null);

/** The whole window: a calm screen, a reload, and the diagnostics to send if it keeps happening. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      area="app"
      fallback={({ id }) => (
        <div role="alert" className="flex h-screen items-center justify-center bg-background p-10 text-center" data-testid="app-boundary">
          <div className="max-w-sm">
            <p className="text-md font-semibold tracking-tight">Something went wrong</p>
            <p className="mt-1.5 text-sm text-muted-foreground">Terno hit an error and can't show this window. Your mail is safe.</p>
            <div className="mt-5 flex justify-center gap-2">
              <Button data-testid="app-boundary-reload" onClick={() => location.reload()}>
                Reload
              </Button>
              <Button variant="outline" data-testid="app-boundary-export" onClick={() => void exportDiagnostics()}>
                Export Diagnostics…
              </Button>
            </div>
            {id && <p className="mt-6 text-xs text-muted-foreground tabular-nums select-text">Reference {shortId(id)}</p>}
          </div>
        </div>
      )}
    >
      <TestThrow area="app" />
      {children}
    </Boundary>
  );
}

/** One pane (the reader, a settings section): the rest of the window keeps working. */
export function PaneBoundary({ area, resetKey, title, children }: { area: "reader" | "settings"; resetKey?: unknown; title: string; children: ReactNode }) {
  return (
    <Boundary
      area={area}
      resetKey={resetKey}
      fallback={({ id, reset }) => (
        <div role="alert" className="flex h-full min-h-48 items-center justify-center p-8 text-center" data-testid={`${area}-boundary`}>
          <div className="max-w-xs">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">Terno saved the details of the error on this computer.</p>
            <Button size="sm" variant="outline" className="mt-3.5" data-testid={`${area}-boundary-retry`} onClick={reset}>
              Try Again
            </Button>
            {id && <p className="mt-4 text-xs text-muted-foreground tabular-nums select-text">Reference {shortId(id)}</p>}
          </div>
        </div>
      )}
    >
      <TestThrow area={area} />
      {children}
    </Boundary>
  );
}
