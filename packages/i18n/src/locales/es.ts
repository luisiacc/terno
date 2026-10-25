import type { LocaleCheck } from "../types";

/** Español (es-MX). Same keys, placeholders and tags as en.ts: the type check at the bottom enforces it. */
const es = {
  // ── common
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.save": "Guardar",
  "common.done": "Listo",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.edit": "Editar",
  "common.undo": "Deshacer",
  "common.retry": "Reintentar",
  "common.ok": "Aceptar",
  "common.continue": "Continuar",
  "common.back": "Atrás",
  "common.copy": "Copiar",
  "common.copied": "Copiado",
  "common.reset": "Restablecer",
  "common.show": "Mostrar",
  "common.view": "Ver",
  "common.dismiss": "Cerrar",
  "common.loading": "Cargando…",
  "common.add": "Añadir",
  "common.apply": "Aplicar",
  "common.change": "Cambiar",
  "common.connect": "Conectar",
  "common.reconnect": "Reconectar",
  "common.send": "Enviar",
  "common.open": "Abrir",
  "common.search": "Buscar",
  "common.settings": "Ajustes",
  "common.always": "Siempre",
  "common.never": "Nunca",
  "common.ask": "Preguntar",
  "common.on": "Activado",
  "common.off": "Desactivado",
  "common.noSubject": "(sin asunto)",
  "common.conversations": { one: "# conversación", other: "# conversaciones" },
  "common.messages": { one: "# mensaje", other: "# mensajes" },

  // ── views and dates (lib/format.ts)
  "view.inbox": "Entrada",
  "view.starred": "Destacados",
  "view.sent": "Enviados",
  "view.archive": "Archivo",
  "view.spam": "Spam",
  "view.trash": "Papelera",
  "view.all": "Todo el correo",
  "date.yesterday": "Ayer",
  "unit.days": { one: "día", other: "días" },

  // ── language (settings → general)
  "language.label": "Idioma",
  "language.hint": "El idioma de los menús, botones y mensajes de Terno.",
  "language.system": "Sistema ({language})",

  // ── app shell
  // @app

  // ── settings
  // @settings

  // ── list, reader, sidebar, menus, categories
  // @list

  // ── compose
  // @compose

  // ── palette, shortcuts, snack
  // @palette

  // ── print
  // @print

  // ── diagnostics
  // @diag

  // ── desktop menus (title case in English, macOS HIG)
  "menu.about": "Acerca de {app}",
  "menu.services": "Servicios",
  "menu.hide": "Ocultar {app}",
  "menu.hideOthers": "Ocultar otros",
  "menu.showAll": "Mostrar todo",
  "menu.quit": "Salir de {app}",
  "menu.file": "Archivo",
  "menu.print": "Imprimir…",
  "menu.exportPdf": "Exportar como PDF…",
  "menu.edit": "Edición",
  "menu.undo": "Deshacer",
  "menu.redo": "Rehacer",
  "menu.cut": "Cortar",
  "menu.copy": "Copiar",
  "menu.paste": "Pegar",
  "menu.pasteAndMatchStyle": "Pegar con el mismo estilo",
  "menu.delete": "Eliminar",
  "menu.selectAll": "Seleccionar todo",
  "menu.speech": "Voz",
  "menu.startSpeaking": "Iniciar locución",
  "menu.stopSpeaking": "Detener locución",
  "menu.view": "Ver",
  "menu.filterUnread": "Filtrar por no leídos",
  "menu.reload": "Volver a cargar",
  "menu.devTools": "Herramientas para desarrolladores",
  "menu.actualSize": "Tamaño real",
  "menu.zoomIn": "Ampliar",
  "menu.zoomOut": "Reducir",
  "menu.fullScreen": "Pantalla completa",
  "menu.window": "Ventana",
  "menu.minimize": "Minimizar",
  "menu.zoom": "Zoom",
  "menu.front": "Traer todo al frente",
  "menu.help": "Ayuda",
  "menu.exportDiagnostics": "Exportar diagnóstico…",
  "menu.showLogs": "Mostrar registros",

  // ── desktop (dialogs, save panels)
  // @desktop

  // ── backend and providers (errors shown to the user)
  // @backend

  // ── web (storage, gate, onboarding)
  // @web

  // ── ui components
  // @ui
} as const;

export default es satisfies LocaleCheck<typeof es>;
