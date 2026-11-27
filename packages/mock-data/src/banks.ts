export const FIRST_NAMES = [
  "Lucía", "Mateo", "Sofía", "Santiago", "Valentina", "Sebastián", "Camila", "Diego", "Mariana", "Nicolás",
  "Isabella", "Andrés", "Daniela", "Alejandro", "Gabriela", "Joaquín", "Renata", "Emilio", "Ximena", "Tomás",
  "Paula", "Martín", "Ana", "Javier", "Elena", "Ricardo", "Carmen", "Fernando", "Natalia", "Raúl",
  "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Mia", "Lucas", "Chloe", "Jack",
  "Yuki", "Hiro", "Mei", "Wei", "Priya", "Arjun", "Fatima", "Omar", "Zoë", "Björn",
];

export const LAST_NAMES = [
  "García", "Martínez", "López", "Hernández", "González", "Pérez", "Rodríguez", "Sánchez", "Ramírez", "Torres",
  "Flores", "Rivera", "Gómez", "Díaz", "Cruz", "Morales", "Reyes", "Gutiérrez", "Ortiz", "Peña",
  "Castillo", "Jiménez", "Vargas", "Romero", "Muñoz", "Álvarez", "Mendoza", "Ruiz", "Navarro", "Cordero",
  "Smith", "Johnson", "Brown", "Taylor", "Wilson", "Nakamura", "Chen", "Kumar", "Haddad", "Lindqvist",
];

export const PERSONAL_DOMAINS = ["gmail.com", "outlook.com", "icloud.com", "yahoo.com", "proton.me", "hotmail.com"];

export const CLIENT_COMPANIES = [
  { name: "Café Altura", domain: "cafealtura.mx" },
  { name: "Nómada Viajes", domain: "nomadaviajes.com" },
  { name: "Lumen Health", domain: "lumenhealth.io" },
  { name: "Banco Andino", domain: "bancoandino.co" },
  { name: "Orbita Labs", domain: "orbitalabs.dev" },
  { name: "Panadería Lupita", domain: "panaderialupita.mx" },
  { name: "Northwind Traders", domain: "northwind.com" },
  { name: "Estudio Ámbar", domain: "estudioambar.es" },
];

export interface NewsletterSource {
  name: string;
  email: string;
  listId: string;
  subjects: string[];
  topics: string[];
  lang: "es" | "en";
}

export const NEWSLETTERS: NewsletterSource[] = [
  {
    name: "Xataka",
    email: "boletin@xataka.com",
    listId: "boletin.xataka.com",
    subjects: ["Lo mejor de la semana en tecnología", "Así es el nuevo {product}", "{n} gadgets que cambiarán tu {thing}"],
    topics: ["inteligencia artificial", "teléfonos plegables", "baterías de estado sólido", "realidad mixta", "chips de 2 nanómetros"],
    lang: "es",
  },
  {
    name: "Morning Brew",
    email: "crew@morningbrew.com",
    listId: "daily.morningbrew.com",
    subjects: ["☕ Markets wobble as {topic} heats up", "Your Tuesday brief: {topic}", "The big story: {topic}"],
    topics: ["interest rates", "the chip shortage", "streaming wars", "electric vehicles", "remote work"],
    lang: "en",
  },
  {
    name: "Platzi",
    email: "hola@platzi.com",
    listId: "news.platzi.com",
    subjects: ["Nuevo curso: {topic}", "🔥 Última semana con descuento en {topic}", "Tu ruta de aprendizaje en {topic}"],
    topics: ["TypeScript avanzado", "diseño de producto", "SQL desde cero", "React Native", "liderazgo técnico"],
    lang: "es",
  },
  {
    name: "Hacker Newsletter",
    email: "kale@hackernewsletter.com",
    listId: "hackernewsletter.com",
    subjects: ["Hacker Newsletter #{n}", "#{n}: {topic} and more"],
    topics: ["SQLite internals", "Rust in the kernel", "local-first software", "CRDTs", "WebGPU"],
    lang: "en",
  },
  {
    name: "Substack · El Arquitecto",
    email: "elarquitecto@substack.com",
    listId: "elarquitecto.substack.com",
    subjects: ["Sobre {topic}", "Notas de la semana: {topic}", "Por qué {topic} importa"],
    topics: ["sistemas distribuidos", "colas de mensajes", "bases de datos embebidas", "arquitectura hexagonal", "observabilidad"],
    lang: "es",
  },
  {
    name: "Figma",
    email: "no-reply@figma.com",
    listId: "updates.figma.com",
    subjects: ["What's new in Figma: {topic}", "Config recap: {topic}"],
    topics: ["variables", "dev mode", "auto layout", "prototyping", "design systems"],
    lang: "en",
  },
];

export interface NotificationSource {
  name: string;
  email: string;
  listId: string | null;
  kind: "receipt" | "shipping" | "bank" | "dev" | "travel" | "calendar";
  lang: "es" | "en";
}

export const NOTIFIERS: NotificationSource[] = [
  { name: "Amazon México", email: "pedidos@amazon.com.mx", listId: null, kind: "shipping", lang: "es" },
  { name: "Mercado Libre", email: "info@mercadolibre.com", listId: null, kind: "shipping", lang: "es" },
  { name: "Uber Receipts", email: "uber.receipts@uber.com", listId: null, kind: "receipt", lang: "es" },
  { name: "Rappi", email: "recibos@rappi.com", listId: null, kind: "receipt", lang: "es" },
  { name: "Stripe", email: "receipts@stripe.com", listId: null, kind: "receipt", lang: "en" },
  { name: "Vercel", email: "billing@vercel.com", listId: null, kind: "receipt", lang: "en" },
  { name: "BBVA", email: "alertas@bbva.mx", listId: null, kind: "bank", lang: "es" },
  { name: "Banco Andino", email: "notificaciones@bancoandino.co", listId: null, kind: "bank", lang: "es" },
  { name: "GitHub", email: "notifications@github.com", listId: "web.acme.github.com", kind: "dev", lang: "en" },
  { name: "GitHub", email: "notifications@github.com", listId: "api.acme.github.com", kind: "dev", lang: "en" },
  { name: "Linear", email: "notifications@linear.app", listId: null, kind: "dev", lang: "en" },
  { name: "Aeroméxico", email: "reservaciones@aeromexico.com", listId: null, kind: "travel", lang: "es" },
  { name: "Airbnb", email: "automated@airbnb.com", listId: null, kind: "travel", lang: "es" },
  { name: "Google Calendar", email: "calendar-notification@google.com", listId: null, kind: "calendar", lang: "es" },
];

export const SPAMMERS = [
  { name: "Premios Express", email: "ganador@premios-express.biz" },
  { name: "Crypto Signals", email: "vip@cryptosignals.top" },
  { name: "Farmacia Online 24h", email: "ofertas@farma24h.click" },
  { name: "Lottery Department", email: "claims@intl-lottery.win" },
];

export const PROJECT_WORDS = [
  "rediseño del checkout", "migración a SQLite", "landing de primavera", "app móvil", "sistema de diseño",
  "panel de métricas", "integración con Stripe", "onboarding", "búsqueda instantánea", "API de pagos",
  "campaña de Navidad", "auditoría de accesibilidad", "nuevo logo", "portal de clientes",
];

export const WORK_SUBJECTS_ES = [
  "Propuesta: {project}",
  "Revisión de {project}",
  "Planeación del sprint {n}",
  "Reunión de seguimiento — {project}",
  "Dudas sobre {project}",
  "Presupuesto actualizado para {project}",
  "Feedback del cliente sobre {project}",
  "Entrega final de {project}",
];

export const WORK_SUBJECTS_EN = [
  "Proposal: {project}",
  "Quick sync on {project}",
  "Sprint {n} retro notes",
  "Blockers for {project}",
  "Design review — {project}",
];

export const PERSONAL_SUBJECTS = [
  "¿Comida el sábado?",
  "Fotos del viaje a Oaxaca 📸",
  "Cumpleaños de mamá 🎂",
  "Re: departamento en la Roma",
  "Recomendaciones de libros",
  "¿Vamos al concierto?",
  "Boletos para el partido ⚽",
  "Receta de la abuela",
  "Plan para el puente",
  "Te mando el documento",
  "Weekend plans?",
  "Long time no see!",
  "旅行の写真",
];

export const OPENERS_ES = ["Hola {name},", "¡Hola {name}!", "Buen día {name},", "Qué tal {name},", "{name},"];
export const OPENERS_EN = ["Hi {name},", "Hey {name}!", "Hello {name},", "{name},"];

export const SENTENCES_ES = [
  "Te comparto la información que platicamos ayer en la reunión.",
  "¿Podrías revisar el documento antes del viernes?",
  "El cliente pidió algunos cambios en la sección de precios.",
  "Adjunto la factura correspondiente al mes de marzo.",
  "Quedo atento a tus comentarios.",
  "Creo que podemos mover la entrega una semana sin problema.",
  "La reunión será por videollamada a las 10 de la mañana.",
  "Ya subí los archivos a la carpeta compartida.",
  "Me parece muy buena idea, avancemos con esa opción.",
  "Necesitamos confirmar el presupuesto con finanzas.",
  "El diseño quedó increíble, felicita al equipo de mi parte.",
  "Hubo un problema con el pago, ¿lo puedes revisar?",
  "Mañana te llamo para ver los detalles.",
  "La canción que te mandé es la del concierto.",
  "Gracias por la paciencia, sé que fue una semana pesada.",
  "Te recuerdo que el contrato vence el próximo mes.",
  "¿Tienes disponibilidad el jueves para una llamada rápida?",
  "Encontré un error en la búsqueda del sitio, ya abrí un ticket.",
  "Las fotos del evento están en el enlace de abajo.",
  "Ojo con las fechas del calendario, cambiaron otra vez.",
];

export const SENTENCES_EN = [
  "Following up on our conversation from yesterday.",
  "Could you take a look at the draft before Friday?",
  "The client asked for a few changes to the pricing page.",
  "I've attached the invoice for this month.",
  "Let me know what you think.",
  "We can push the deadline by a week if needed.",
  "The call is at 10am, link in the calendar invite.",
  "Uploaded the assets to the shared drive.",
  "Sounds great, let's go with that option.",
  "We still need sign-off from finance on the budget.",
  "Found a bug in search, filed a ticket already.",
  "Thanks for your patience this week.",
];

export const CLOSERS_ES = ["Saludos,", "Un abrazo,", "Gracias,", "Quedo pendiente,", "Abrazo,"];
export const CLOSERS_EN = ["Best,", "Thanks,", "Cheers,", "Talk soon,"];

export const ATTACHMENT_NAMES = [
  { filename: "factura-{n}.pdf", mime: "application/pdf" },
  { filename: "propuesta-v{n}.pdf", mime: "application/pdf" },
  { filename: "presupuesto.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { filename: "foto-{n}.jpg", mime: "image/jpeg" },
  { filename: "contrato-firmado.pdf", mime: "application/pdf" },
  { filename: "mockups.fig", mime: "application/octet-stream" },
  { filename: "boarding-pass.pdf", mime: "application/pdf" },
];

/*
 * Plan 289: the demo edition's lists, one language each. The fixture above draws from the shared lists (mixed); the demo
 * draws an English account's mail from EN_* and the Spanish account's from ES_*, so no English account shows a word of
 * Spanish (no accented letter either: the demo's test checks it).
 */
export type Lang = "en" | "es";

export const EN_FIRST_NAMES = [
  "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Mia", "Lucas", "Chloe", "Jack",
  "Grace", "Henry", "Sophie", "Oliver", "Hannah", "James", "Nora", "Owen", "Ruby", "Caleb",
  "Priya", "Arjun", "Wei", "Mei", "Yuki", "Hiro", "Omar", "Fatima", "Zara", "Daniel",
  "Rachel", "Ben", "Claire", "Maya", "Theo", "Isla", "Leo", "Alice", "Max", "Amara",
];
export const EN_LAST_NAMES = [
  "Smith", "Johnson", "Brown", "Taylor", "Wilson", "Nakamura", "Chen", "Kumar", "Haddad", "Walker",
  "Harris", "Clarke", "Patel", "Shah", "Murphy", "Bennett", "Hughes", "Foster", "Reed", "Collins",
  "Brooks", "Turner", "Price", "Kim", "Park", "Nguyen", "Cohen", "Fischer", "Okafor", "Lindgren",
];
/** the fixture's Spanish names only (its lists hold them first) */
export const ES_FIRST_NAMES = FIRST_NAMES.slice(0, 30);
export const ES_LAST_NAMES = LAST_NAMES.slice(0, 30);

export const EN_CLIENT_COMPANIES = [
  { name: "Northwind Traders", domain: "northwind.com" },
  { name: "Lumen Health", domain: "lumenhealth.io" },
  { name: "Orbita Labs", domain: "orbitalabs.dev" },
  { name: "Harbor & Pine", domain: "harborpine.com" },
  { name: "Fieldstone Bakery", domain: "fieldstonebakery.com" },
  { name: "Atlas Travel", domain: "atlastravel.co" },
];
export const ES_CLIENT_COMPANIES = CLIENT_COMPANIES.filter((c) => ["cafealtura.mx", "nomadaviajes.com", "bancoandino.co", "panaderialupita.mx", "estudioambar.es"].includes(c.domain));

export const EN_NEWSLETTERS: NewsletterSource[] = [
  ...NEWSLETTERS.filter((n) => n.lang === "en"),
  {
    name: "Fieldnotes Weekly",
    email: "hello@fieldnotes.email",
    listId: "weekly.fieldnotes.email",
    subjects: ["Fieldnotes #{n}: {topic}", "This week in design: {topic}", "Three links on {topic}"],
    topics: ["type on screens", "calm software", "design critiques", "color systems", "writing for interfaces"],
    lang: "en",
  },
  {
    name: "Product Hunt Daily",
    email: "hello@digest.producthunt.com",
    listId: "digest.producthunt.com",
    subjects: ["Today's top products: {topic}", "The best of {topic} this week"],
    topics: ["AI note takers", "email clients", "habit trackers", "password managers", "photo editors"],
    lang: "en",
  },
];
export const ES_NEWSLETTERS = NEWSLETTERS.filter((n) => n.lang === "es");

/** the English accounts' notifications: GitHub and Linear, and English versions of the shops, banks and trips */
export const EN_NOTIFIERS: NotificationSource[] = [
  { name: "Amazon", email: "shipment-tracking@amazon.com", listId: null, kind: "shipping", lang: "en" },
  { name: "Uber Receipts", email: "uber.receipts@uber.com", listId: null, kind: "receipt", lang: "en" },
  { name: "DoorDash", email: "no-reply@doordash.com", listId: null, kind: "receipt", lang: "en" },
  ...NOTIFIERS.filter((n) => n.lang === "en"),
  { name: "Chase", email: "no.reply.alerts@chase.com", listId: null, kind: "bank", lang: "en" },
  { name: "Delta Air Lines", email: "deltaairlines@t.delta.com", listId: null, kind: "travel", lang: "en" },
  { name: "Airbnb", email: "automated@airbnb.com", listId: null, kind: "travel", lang: "en" },
  { name: "Google Calendar", email: "calendar-notification@google.com", listId: null, kind: "calendar", lang: "en" },
];
export const ES_NOTIFIERS = NOTIFIERS.filter((n) => n.lang === "es");

export const EN_SPAMMERS = [
  { name: "Prize Center", email: "winner@prize-center.biz" },
  { name: "Crypto Signals", email: "vip@cryptosignals.top" },
  { name: "Pharmacy 24h", email: "deals@pharma24h.click" },
  { name: "Lottery Department", email: "claims@intl-lottery.win" },
];
export const ES_SPAMMERS = SPAMMERS.filter((s) => ["ganador@premios-express.biz", "ofertas@farma24h.click"].includes(s.email));
export const SPAM = {
  en: { subjects: ["You've won an iPhone 17!!", "URGENT: claim your prize now", "💰 Earn $5,000 a day from home", "Your account will be suspended"], body: "Click here to claim your prize before the offer expires." },
  es: { subjects: ["¡¡Felicidades!! Has ganado un iPhone 17", "💰 Gana $5,000 diarios desde casa", "Tu cuenta será suspendida"], body: "Haz clic aquí para reclamar tu premio antes de que expire la oferta." },
};

export const EN_PROJECT_WORDS = [
  "checkout redesign", "SQLite migration", "spring landing page", "mobile app", "design system",
  "metrics dashboard", "Stripe integration", "onboarding", "instant search", "payments API",
  "holiday campaign", "accessibility audit", "new logo", "client portal",
];

export const EN_WORK_SUBJECTS = [
  ...WORK_SUBJECTS_EN,
  "Review of the {project}",
  "Sprint {n} planning",
  "Follow-up meeting: {project}",
  "Questions about the {project}",
  "Updated budget for the {project}",
  "Client feedback on the {project}",
];

export const EN_PERSONAL_SUBJECTS = [
  "Lunch on Saturday?",
  "Photos from the lake trip 📸",
  "Mom's birthday 🎂",
  "Re: the apartment on Elm Street",
  "Book recommendations",
  "Concert on Friday?",
  "Tickets for the game 🏀",
  "Grandma's recipe",
  "Plans for the long weekend",
  "Sending you the document",
  "Weekend plans?",
  "Long time no see!",
];
export const ES_PERSONAL_SUBJECTS = PERSONAL_SUBJECTS.slice(0, 10);

/** the fixture's twelve, then the rest of the Spanish ones' meaning, so both languages say the same things */
export const EN_SENTENCES = [
  ...SENTENCES_EN,
  "There was a problem with the payment, can you take a look?",
  "I'll call you tomorrow to go over the details.",
  "The song I sent you is the one from the concert.",
  "Just a reminder that the contract renews next month.",
  "Are you free on Thursday for a quick call?",
  "The photos from the event are in the link below.",
  "Heads up: the calendar dates changed again.",
  "The design turned out great, please thank the team for me.",
];

export const EN_ATTACHMENT_NAMES = [
  { filename: "invoice-{n}.pdf", mime: "application/pdf" },
  { filename: "proposal-v{n}.pdf", mime: "application/pdf" },
  { filename: "budget.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { filename: "photo-{n}.jpg", mime: "image/jpeg" },
  { filename: "signed-contract.pdf", mime: "application/pdf" },
  { filename: "mockups.fig", mime: "application/octet-stream" },
  { filename: "boarding-pass.pdf", mime: "application/pdf" },
];

/** the demo's newsletter paragraphs: what a newsletter says (the fixture's borrow the conversations' sentences) */
export const NEWSLETTER_LINES: Record<Lang, string[]> = {
  en: [
    "Here is what caught our eye this week.",
    "Plus: three tools we tried and kept.",
    "Our pick of the week is a short read worth your time.",
    "A reader wrote in with a question we loved.",
    "The full story is on our site.",
    "Next week: a deep dive with a guest writer.",
    "Thanks for reading, and see you next week.",
  ],
  es: [
    "Esto fue lo que más nos llamó la atención esta semana.",
    "Además: tres herramientas que probamos y nos quedamos.",
    "Nuestra recomendación de la semana es una lectura corta que vale la pena.",
    "Un lector nos escribió con una pregunta que nos encantó.",
    "La historia completa está en nuestro sitio.",
    "La próxima semana: un análisis a fondo con un autor invitado.",
    "Gracias por leer, nos vemos la próxima semana.",
  ],
};
