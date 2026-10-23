import { Button } from "@unica/ui/components/button";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { requestTakeover, takeBack } from "./connect";
import { useWeb } from "./lifecycle";

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

const FATAL_TITLE: Record<string, string> = {
  SCHEMA_NEWER: "Esta pestaña tiene una versión anterior de Única",
  BUILD_MISMATCH: "Esta pestaña tiene una versión anterior de Única",
  UNAVAILABLE: "Este navegador no puede guardar tu correo",
  OPEN_FAILED: "No se pudo abrir tu buzón",
  CRASHED: "El motor de correo se detuvo",
};

/**
 * The web's lifecycle over the app: one tab owns the mailbox at a time, a
 * newer build takes over cleanly, and an open error never swaps the mailbox
 * for an empty one (it says so and offers to retry).
 */
export function WebGate() {
  const { phase, progress, code, message, update } = useWeb();
  if (phase === "starting" && progress) {
    return (
      <Screen testId="web-starting" title={progress}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </Screen>
    );
  }
  if (phase === "elsewhere" || phase === "taking-over") {
    return (
      <Screen testId="web-elsewhere" title="Única está abierta en otra pestaña" body="Tu buzón solo puede estar abierto en una pestaña a la vez.">
        <Button data-testid="web-use-here" disabled={phase === "taking-over"} onClick={() => requestTakeover()}>
          {phase === "taking-over" && <Loader2 className="animate-spin" />} Usar aquí
        </Button>
      </Screen>
    );
  }
  if (phase === "taken") {
    return (
      <Screen testId="web-taken" title="Única se abrió en otra pestaña" body="Esta pestaña ya no tiene tu buzón abierto.">
        <Button data-testid="web-take-back" onClick={takeBack}>
          Usar aquí
        </Button>
      </Screen>
    );
  }
  if (phase === "fatal") {
    const stale = code === "SCHEMA_NEWER" || code === "BUILD_MISMATCH";
    return (
      <Screen
        testId="web-fatal"
        title={FATAL_TITLE[code ?? "OPEN_FAILED"] ?? FATAL_TITLE.OPEN_FAILED!}
        body={
          <>
            <p>{stale ? "Tu buzón ya usa una versión más nueva. Recarga para actualizar; no se ha cambiado nada." : "Tu correo sigue guardado tal como estaba; no se creó un buzón nuevo."}</p>
            {message && !stale && <p className="mt-2 font-mono text-xs break-words">{message}</p>}
          </>
        }
      >
        <Button data-testid="web-reload" onClick={() => location.reload()}>
          {stale ? "Recargar" : "Reintentar"}
        </Button>
      </Screen>
    );
  }
  if (update) {
    return (
      <div className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-lg" data-testid="web-update">
        Hay una versión nueva de Única
        <Button size="sm" onClick={update.apply}>
          Recargar
        </Button>
      </div>
    );
  }
  return null;
}
