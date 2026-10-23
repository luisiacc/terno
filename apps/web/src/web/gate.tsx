import { Button } from "@unica/ui/components/button";
import { Loader2 } from "lucide-react";
import { requestTakeover, takeBack } from "./connect";
import { useWeb } from "./lifecycle";

function Screen({ title, body, children, testId }: { title: string; body?: React.ReactNode; children?: React.ReactNode; testId: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-10 text-center" data-testid={testId}>
      <div className="max-w-md">
        <p className="font-semibold">{title}</p>
        {body && <div className="mt-1.5 text-sm text-muted-foreground">{body}</div>}
        {children && <div className="mt-4 flex justify-center gap-2">{children}</div>}
      </div>
    </div>
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
