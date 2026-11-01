import type { SiteCopy } from "./en";

export const es: SiteCopy = {
  lang: "es",
  meta: {
    title: "Terno: correo instantáneo y privado para Mac",
    description:
      "Terno es un cliente de correo rápido para Mac, pensado para el teclado. Todas tus cuentas en una bandeja. Búsqueda instantánea. Totalmente local, sin cuenta.",
  },
  skip: "Ir al contenido",
  nav: { features: "Funciones", privacy: "Privacidad", source: "Código", download: "Descargar", language: "English", languageHref: "/", home: "Inicio de Terno" },
  hero: {
    title: "El último cliente de correo que probarás.",
    subtitle: "Todas tus cuentas en una bandeja. Búsqueda instantánea. Archiva un correo y todos los parecidos se archivan también. Totalmente local, sin cuenta.",
    note: "Gratis · macOS en Apple silicon",
  },
  download: {
    mac: "Descargar para Mac",
    macSub: "Apple silicon",
    other: "Windows y Linux",
    otherSub: "Únete a la lista",
  },
  features: {
    unified: {
      title: "Todas las cuentas. Una bandeja.",
      body: "Gmail, Outlook y cualquier cuenta IMAP/SMTP: una sola lista. Cada fila muestra de qué cuenta es, para que nunca respondas desde la equivocada.",
      points: ["Gmail, Outlook, cualquier IMAP/SMTP", "Cuentas ilimitadas", "Categorías que las abarcan todas"],
    },
    local: {
      title: "Sin cuenta. Sin nube. Solo tu Mac.",
      body: "Terno habla con tus servidores de correo y con nada más. Tu correo, tus contactos y el índice de búsqueda viven en tu Mac.",
      points: ["Privado desde el primer momento", "Imágenes remotas solo si las pides", "Cero rastreo"],
    },
    search: {
      title: "Búsqueda instantánea.",
      body: "Cada mensaje, cada cuenta, cada carpeta, también el archivo. Resultados mientras escribes.",
      points: ["Por persona, asunto o adjunto", "Décadas de correo, sin esperas", "Funciona sin conexión"],
    },
    speed: {
      title: "Nada espera.",
      body: "Cada acción ocurre en cuanto pulsas la tecla. El servidor se pone al día por detrás.",
      points: ["Abre en menos de un segundo", "Ligero con la memoria y la batería", "En silencio cuando no lo usas"],
    },
    triage: {
      title: "Archiva uno. Despeja todos.",
      body: "Archiva una promoción y Terno te ofrece despejar todas las parecidas, y lo que llegue después. Una tecla. Un deshacer.",
      points: ["Por remitente, dominio o lista", "Un filtro para el futuro, en el mismo paso", "Un solo deshacer para todo"],
    },
    codes: {
      title: "Códigos de acceso, a un clic.",
      body: "El código aparece en el propio mensaje. Clic, pegar, listo.",
      points: [],
    },
    themes: {
      title: "Tres diseños. Dieciocho paletas.",
      body: "Lumen cálido, Atelier editorial o macOS al estilo de Apple Mail, con cualquier tema de color, de Solarized a Dracula. O trae el tuyo.",
      points: ["Claro y oscuro en todos", "Todos revisados en contraste", "Animaciones que puedes reducir o quitar"],
    },
    snippets: {
      title: "Escríbelo una vez.",
      body: "Guarda las respuestas que envías cada semana. ⌘; inserta una, con el nombre ya puesto.",
      points: [],
    },
    palette: {
      title: "⌘K lo hace todo.",
      body: "Cada acción, carpeta, ajuste y plantilla, a unas letras. Lo que más usas sale primero.",
      points: [],
    },
    keyboard: {
      title: "Olvídate del ratón.",
      body: "Muévete, archiva, clasifica, responde y deshaz desde el teclado. Pulsa ? para ver todos los atajos.",
      points: [],
    },
    open: {
      title: "No te fíes de nuestra palabra.",
      body: "Cada línea de Terno es pública. Mira exactamente qué se guarda y qué viaja por la red. Tres años después de cada versión, es totalmente de código abierto.",
      points: [],
      cta: "Leer el código en GitHub",
    },
  },
  keys: [
    { keys: ["J", "K"], label: "Siguiente, anterior" },
    { keys: ["E"], label: "Archivar" },
    { keys: ["L"], label: "Clasificar" },
    { keys: ["R"], label: "Responder" },
    { keys: ["/"], label: "Buscar" },
    { keys: ["⌘", "K"], label: "Paleta de comandos" },
    { keys: ["Z"], label: "Deshacer" },
    { keys: ["?"], label: "Todos los atajos" },
  ],
  stats: [
    { value: "Al instante", label: "búsqueda en todas tus cuentas" },
    { value: "0", label: "servidores de Terno entre tú y tu correo" },
    { value: "18", label: "temas de color, en tres diseños" },
  ],
  closing: {
    title: "Recupera tu bandeja de entrada.",
    body: "Gratis. Sin cuenta. Sin registro. Solo tu correo.",
  },
  waitlist: {
    title: "Windows y Linux están en camino.",
    body: "Déjanos tu correo y te escribiremos una vez, cuando Terno esté listo para tu equipo. Nada más.",
    email: "Correo",
    placeholder: "tu@ejemplo.com",
    platform: "Plataforma",
    platforms: { windows: "Windows", linux: "Linux", mac: "Mac (Apple silicon)", "mac-intel": "Mac (Intel)" },
    submit: "Unirme a la lista",
    sending: "Uniéndote…",
    thanks: "Ya estás en la lista. Te escribiremos cuando esté listo.",
    invalid: "Ese correo no parece correcto. Revísalo e inténtalo de nuevo.",
    busy: "Demasiados intentos a la vez. Espera un minuto y vuelve a intentarlo.",
    full: "La lista está llena por ahora. Vuelve pronto.",
    error: "Algo falló de nuestro lado. Inténtalo de nuevo en un momento.",
    note: "Guardamos tu correo y tu plataforma solo para avisarte del lanzamiento, y luego los borramos.",
  },
  footer: {
    tagline: "El último cliente de correo que probarás.",
    privacy: "Privacidad",
    source: "Código",
    license: "Licencia",
    copyright: "© 2026 Terno",
  },
  alt: {
    inbox: "La bandeja unificada de Terno: conversaciones de cuatro cuentas en una lista, con una conversación abierta al lado",
    "inbox-macos": "Terno con el diseño macOS, compacto y al estilo de Apple Mail",
    "inbox-atelier": "Terno con el diseño Atelier, títulos con serifa sobre papel",
    code: "Un código de verificación en su mensaje de la lista, con un botón para copiarlo",
    search: "Resultados de búsqueda de «hopper ride»: más de 100 resultados, al instante",
    palette: "La paleta de comandos abierta, con los comandos de archivar que coinciden con lo escrito",
    snippets: "La lista de plantillas abierta sobre una respuesta, cada una con su vista previa",
    "archive-similar": "Tras archivar una promoción, Terno ofrece archivar las otras 14 del mismo remitente",
    "file-similar": "Tras clasificar un boletín en Reading, Terno ofrece clasificar los otros 87, y su correo futuro",
    shortcuts: "La hoja de atajos de teclado",
    "palette-dracula": "Terno con el tema de color Apple en modo claro y Dracula en modo oscuro",
    "palette-nord": "Terno con su propio tema de color en modo claro y Nord en modo oscuro",
    "palette-solarized": "Terno con Solarized en modo claro y Tokyo Night en modo oscuro",
    "palette-catppuccin": "Terno con el tema de color Catppuccin, Latte en modo claro y Mocha en modo oscuro",
    "palette-gruvbox": "Terno con el tema de color Gruvbox",
  },
  pages: {
    download: {
      title: "La primera versión está en camino",
      body: "Terno para Mac aún no está publicado. Déjanos tu correo y te escribiremos el día que lo esté.",
    },
    waitlist: { title: "Únete a la lista de espera" },
    notFound: { title: "Esta página no existe", body: "Puede que el enlace sea antiguo o esté mal escrito.", home: "Ir a la página de inicio" },
    privacy: {
      title: "Privacidad",
      intro: "La app Terno guarda tu correo en tu Mac. Esta página trata de este sitio web.",
      sections: [
        {
          title: "Qué guarda este sitio",
          body: "Solo lo que das a la lista de espera: tu dirección de correo, la plataforma que elegiste y cuándo te uniste. Nada más se guarda. No hay cookies, ni analítica, ni scripts o fuentes de terceros.",
        },
        {
          title: "Qué pasa sin guardarse",
          body: "Tu dirección IP se usa un momento para frenar abusos (unas pocas altas por minuto como mucho) y no se guarda. El servidor no registra lo que envías.",
        },
        {
          title: "Cuánto tiempo lo guardamos",
          body: "Hasta que te escribamos para decirte que Terno está listo para tu plataforma; después se borra. Para que te borremos antes, escribe a la dirección de nuestro perfil de GitHub.",
        },
        {
          title: "La app",
          body: "Terno se conecta a tus propios servidores de correo y, si configuras uno, al proveedor de IA que elijas. No tiene cuenta de Terno y no nos envía nada salvo que decidas enviar un informe de error. El código es público, así que puedes comprobarlo.",
        },
      ],
    },
  },
  shot: { appearance: "Apariencia de la imagen", light: "Claro", dark: "Oscuro", enlarge: "Ampliar imagen", close: "Cerrar" },
  preview: { label: "Vista previa del diseño", of: "de" },
};
