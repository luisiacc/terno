import { DEFAULT_BINDINGS, type Command } from "@unica/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@unica/ui/components/dialog";
import { Shortcut } from "@unica/ui/components/shortcut";
import { setApp, useApp } from "~/state/app";

const LABELS: Partial<Record<Command, string>> = {
  "list.next": "Siguiente conversación",
  "list.prev": "Conversación anterior",
  "list.toggleSelect": "Seleccionar",
  "thread.archive": "Archivar",
  "thread.trash": "Eliminar",
  "thread.spam": "Spam",
  "thread.star": "Destacar",
  "thread.markUnread": "Marcar no leído",
  "thread.category": "Categoría",
  "compose.new": "Escribir",
  "compose.reply": "Responder",
  "compose.replyAll": "Responder a todos",
  "compose.forward": "Reenviar",
  "compose.send": "Enviar",
  "search.focus": "Buscar",
  "palette.open": "Paleta de comandos",
  "go.inbox": "Ir a Entrada",
  "go.starred": "Ir a Destacados",
  "go.sent": "Ir a Enviados",
  "go.archive": "Ir a Archivo",
  "go.trash": "Ir a Papelera",
};

export function ShortcutsDialog() {
  const open = useApp((s) => s.dialog === "shortcuts");
  const seen = new Set<Command>();
  const rows = DEFAULT_BINDINGS.filter((b) => LABELS[b.command] && !seen.has(b.command) && seen.add(b.command));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2">
          {rows.map((b) => (
            <div key={b.command} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{LABELS[b.command]}</span>
              <Shortcut keys={b.keys} />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
