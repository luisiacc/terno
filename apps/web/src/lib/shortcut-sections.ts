import { DEFAULT_BINDINGS, type Command } from "@terno/core";

/** Every command the help lists, by section; each row shows all of its keys. */
export const SECTIONS: { title: string; rows: [Command, string][] }[] = [
  {
    title: "Moverse",
    rows: [
      ["list.next", "Siguiente conversación"],
      ["list.prev", "Conversación anterior"],
      ["list.open", "Abrir"],
      ["search.focus", "Buscar"],
      ["palette.open", "Paleta de comandos"],
      ["help.shortcuts", "Atajos de teclado"],
      ["settings.open", "Ajustes"],
      ["go.inbox", "Ir a Entrada"],
      ["go.starred", "Ir a Destacados"],
      ["go.sent", "Ir a Enviados"],
      ["go.archive", "Ir a Archivo"],
      ["go.trash", "Ir a Papelera"],
    ],
  },
  {
    title: "Seleccionar",
    rows: [
      ["list.toggleSelect", "Seleccionar o quitar"],
      ["list.selectAll", "Seleccionar todo"],
      ["list.extendNext", "Ampliar hacia abajo"],
      ["list.extendPrev", "Ampliar hacia arriba"],
      ["list.selectRead", "Seleccionar leídos"],
      ["list.selectUnread", "Seleccionar no leídos"],
      ["list.selectStarred", "Seleccionar destacados"],
      ["list.selectNone", "Deseleccionar"],
      ["reader.close", "Deseleccionar"],
      ["list.menu", "Menú de la conversación"],
    ],
  },
  {
    title: "Acciones",
    rows: [
      ["thread.archive", "Archivar"],
      ["thread.trash", "Eliminar"],
      ["thread.spam", "Spam"],
      ["thread.markRead", "Marcar como leído"],
      ["thread.markUnread", "Marcar como no leído"],
      ["thread.toggleRead", "Leído / no leído"],
      ["thread.star", "Destacar"],
      ["thread.category", "Categorías"],
      ["thread.move", "Mover a…"],
      ["action.undo", "Deshacer"],
    ],
  },
  {
    title: "Escribir",
    rows: [
      ["compose.new", "Escribir"],
      ["compose.reply", "Responder"],
      ["compose.replyAll", "Responder a todos"],
      ["compose.forward", "Reenviar"],
      ["compose.send", "Enviar"],
    ],
  },
];

/** Bindings that exist but the dialog doesn't list (the snackbar's own keys are shown on it). */
export const UNLISTED: ReadonlySet<Command> = new Set<Command>(["snackbar.action1", "snackbar.action2", "snackbar.action3", "snackbar.action4", "snackbar.action5", "snackbar.undo", "snackbar.close", "suggestion.accept", "suggestion.reject"]);

/** Every bound command is either listed or deliberately not. */
export const LISTED: ReadonlySet<Command> = new Set(SECTIONS.flatMap((s) => s.rows.map(([c]) => c)));
export const unlistedBindings = () => DEFAULT_BINDINGS.filter((b) => !LISTED.has(b.command) && !UNLISTED.has(b.command)).map((b) => b.command);

