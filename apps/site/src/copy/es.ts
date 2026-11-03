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
      body: "Tu correo va de tu Mac a tus servidores de correo, nunca por los nuestros. Tu correo, tus contactos y el índice de búsqueda viven en tu Mac.",
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
      intro: "Terno guarda tu correo en tu Mac. No hay cuenta de Terno ni ningún servidor de Terno que guarde tu correo. Esta página explica exactamente qué hacen con tus datos la app y este sitio web.",
      updated: "Última actualización: 2 de noviembre de 2026",
      contents: "En esta página",
      sections: [
        {
          id: "who",
          title: "Quiénes somos",
          body: [
            "Terno lo hace Luisiacc LLC («nosotros»). Esta política cubre la app Terno para Mac y este sitio web, terno.app. El código de Terno es público en [GitHub](https://github.com/luisiacc/terno), así que puedes comprobar todo lo que sigue.",
          ],
        },
        {
          id: "on-your-mac",
          title: "Tu correo se queda en tu Mac",
          body: [
            "Terno descarga tu correo de tus proveedores de correo y lo guarda, junto con tus contactos y el índice de búsqueda, en una base de datos en la carpeta de usuario de tu Mac. Tus contraseñas, tokens de inicio de sesión y claves de IA se cifran con una clave guardada en el Llavero de macOS.",
            "Nada de esto se nos envía. No tenemos ningún servidor que reciba tu correo, tus contactos ni nada de lo que haces en la app. No hay analítica ni rastreo.",
          ],
        },
        {
          id: "connections",
          title: "Con quién habla la app",
          body: ["Además de con tus proveedores de correo, Terno solo se conecta a internet para lo siguiente:"],
          points: [
            "**Tus proveedores de correo** (Gmail, iCloud, Outlook o cualquier servidor IMAP/SMTP), para descargar, enviar y organizar tu correo.",
            "**Iconos de sitios web.** Para mostrar el logo de una empresa junto a su correo, Terno pide el icono al propio sitio web de esa empresa. El sitio ve tu dirección IP y nada más. Activado por defecto; puedes desactivarlo en Ajustes → Apariencia.",
            "**Fotos de Google.** Con una cuenta de Google, Terno puede mostrar las fotos de tus contactos de Google. Puedes desactivarlo en Ajustes → Apariencia.",
            "**Las imágenes remotas de los mensajes** solo se cargan cuando tú lo decides, para un mensaje o siempre. Entonces el servidor del remitente ve tu dirección IP, como con cualquier app de correo.",
            "**Actualizaciones.** Terno consulta GitHub si hay una versión nueva al abrirse y cada pocas horas. No se envía nada sobre ti ni sobre tu correo. En Ajustes → General eliges si las versiones nuevas se descargan solas.",
            "**IA**, solo si configuras un proveedor. Consulta [Proveedores de IA](#ai).",
            "**Informes de error**, solo si aceptas. Consulta [Informes de error](#errors).",
            "**Cancelar suscripciones.** Cuando pulsas Cancelar suscripción, Terno contacta con la dirección que el remitente dio para ello.",
          ],
        },
        {
          id: "google",
          title: "Datos de usuario de Google",
          body: [
            "Cuando conectas una cuenta de Google, Google te pide que permitas a Terno:",
          ],
          points: [
            "**Ver tu nombre, tu dirección de correo y tu foto de perfil**, para identificar la cuenta en Terno y, con Fotos de Google activado, mostrar tu foto en el correo que envías.",
            "**Leer, enviar, etiquetar y eliminar tu correo de Gmail** (el permiso `gmail.modify`), para que puedas leer, buscar, enviar, archivar, etiquetar y eliminar tu correo en Terno.",
            "**Ver las direcciones de correo y las fotos de tus contactos** (acceso de solo lectura a tus contactos y a otros contactos), solo para poner la foto correcta junto a quienes te escriben. Puedes desmarcarlo en la pantalla de Google.",
          ],
          after: [
            "Terno usa estos datos solo para ofrecerte las funciones que ves en la app. Se guardan en tu Mac y nunca se nos envían. No los vendemos, no los usamos para publicidad ni para crear perfiles tuyos, ni para desarrollar, mejorar o entrenar modelos de IA, y nadie en Luisiacc LLC los lee.",
            "Terno solo pasa datos de usuario de Google a otros cuando tú se lo pides: al proveedor de IA que elijas, cuando activas una función de IA (solo lo que esa función necesita, descrito más abajo), y a las herramientas de IA de tu Mac que conectes a Terno.",
            "El uso y la transferencia a cualquier otra app, por parte de Terno, de la información recibida de las API de Google se ajustarán a la [Política de datos de usuario de los servicios de API de Google](https://developers.google.com/terms/api-services-user-data-policy), incluidos los requisitos de uso limitado.",
            "Para retirar el acceso de Terno, elimina la cuenta en Ajustes → Cuentas, lo que borra su correo y sus tokens de tu Mac, y luego quita Terno en [myaccount.google.com/permissions](https://myaccount.google.com/permissions).",
          ],
        },
        {
          id: "ai",
          title: "Proveedores de IA",
          body: [
            "La IA está desactivada hasta que eliges un proveedor en Ajustes → IA: Anthropic, OpenAI, un servicio compatible con OpenAI (como OpenRouter, Groq, Together o Azure OpenAI) o un modelo que se ejecuta en tu Mac (Ollama, LM Studio). Tu clave se queda en tu Mac, y las peticiones van directamente de tu Mac a ese proveedor, bajo sus condiciones de privacidad. Con un modelo en tu Mac, nada sale de él.",
            "Qué envía cada función:",
          ],
          points: [
            "**Crear un filtro a partir de tus palabras:** lo que escribiste, la fecha de hoy, las direcciones y nombres de tus cuentas, y los nombres de tus categorías.",
            "**Ayuda para clasificar en categorías** (un interruptor aparte): para un mensaje que Terno no sabe clasificar por sí solo, el nombre y la dirección del remitente, el asunto, los primeros 600 caracteres del texto y los nombres de tus categorías.",
          ],
        },
        {
          id: "agents",
          title: "Herramientas de IA en tu Mac",
          body: [
            "Terno incluye un conector (MCP) que las herramientas de IA de tu Mac, como Claude, pueden usar para buscar, leer, organizar y redactar tu correo cuando lo añades a ellas. No se puede alcanzar desde la red: solo pueden usarlo los programas que se ejecutan con tu usuario en tu Mac y tienen una clave guardada en tu carpeta de Terno, los mismos programas que podrían abrir directamente tus archivos de correo. Lo que esas herramientas hagan con tu correo depende de ellas y de su proveedor. Enviar correo a través de ellas necesita su propio interruptor, desactivado por defecto.",
          ],
        },
        {
          id: "errors",
          title: "Informes de error",
          body: [
            "Cuando algo falla, Terno pregunta antes de enviar un informe (también puedes elegir Siempre o Nunca), y antes puedes ver exactamente qué contiene: el error y en qué parte del código de Terno ocurrió; los pasos justo anteriores, como códigos (por ejemplo, qué vista o diálogo estaba abierto); las versiones de la app y de macOS, tu idioma y el tipo de Mac (procesador y memoria); cuántas cuentas tienes; y un identificador aleatorio que puedes restablecer. Nunca contiene tu correo, direcciones, nombres ni asuntos. Los informes van a Sentry, el servicio que usamos para seguir los errores.",
            "Terno guarda sus propios registros en tu Mac, con un tamaño limitado. No contienen tu correo ni direcciones.",
          ],
        },
        {
          id: "delete",
          title: "Borrar tus datos",
          body: [
            "Eliminar una cuenta en Ajustes → Cuentas borra su correo, sus tokens de inicio de sesión y sus imágenes del buzón de Terno. Antes de que una actualización cambie cómo se guarda tu buzón, Terno guarda una copia por si algo sale mal; una copia hecha antes de que eliminaras la cuenta la sigue conteniendo hasta que se borra, la primera vez que Terno se abre 14 días o más después de la actualización. Para borrarlo todo de una vez, cierra Terno y elimina la carpeta `~/Library/Application Support/Terno` y el ítem del Llavero «Terno Safe Storage».",
          ],
        },
        {
          id: "site",
          title: "Este sitio web",
          body: [
            "Este sitio lo sirve Cloudflare. No tiene cookies, ni analítica, ni scripts o fuentes de terceros.",
            "Solo guarda lo que das a la lista de espera: tu dirección de correo, la plataforma que elegiste y cuándo te uniste. Se borra cuando te escribamos para decirte que Terno está listo para tu plataforma, o antes si lo pides. Tu dirección IP se usa un momento para frenar abusos y no se guarda, y el servidor no registra lo que envías.",
          ],
        },
        {
          id: "children",
          title: "Menores",
          body: ["Terno no está dirigido a menores de 13 años, y no recopilamos sus datos a sabiendas."],
        },
        {
          id: "changes",
          title: "Cambios",
          body: ["Si esta política cambia, actualizaremos esta página y su fecha. Los cambios importantes también aparecerán en las notas de versión de la app."],
        },
        {
          id: "contact",
          title: "Contacto",
          body: ["Para preguntas sobre privacidad, o para que borremos tu entrada de la lista de espera, contacta con Luisiacc LLC a través de [github.com/luisiacc](https://github.com/luisiacc)."],
        },
      ],
    },
  },
  shot: { appearance: "Apariencia de la imagen", light: "Claro", dark: "Oscuro", enlarge: "Ampliar imagen", close: "Cerrar" },
  preview: { label: "Vista previa del diseño", of: "de" },
};
