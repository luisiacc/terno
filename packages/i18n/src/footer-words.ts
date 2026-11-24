import type { LocaleId } from "./locales/index";

/**
 * Phrases that mark a line of a mail's footer in each language (plan 269): a line with one is the sender's fine print,
 * not reading. Mail is matched against every language's phrases, whatever the UI's. A new language must add its own:
 * the Record makes the type check fail until it does. Only phrases that live in footers: "privacy policy" or "terms"
 * also head the paragraph of a notice that changes them. Matching folds case and accents.
 */
export const FOOTER_WORDS: Record<LocaleId, readonly string[]> = {
  en: [
    "unsubscribe",
    "you are receiving",
    "you're receiving",
    "you received this email",
    "you received this message",
    "this email was sent to",
    "this email was intended for",
    "this email is intended for",
    "this message is intended for",
    "this message was sent to",
    "email preferences",
    "notification settings",
    "manage your preferences",
    "manage your notifications",
    "manage your subscriptions",
    "view this email in your browser",
    "view it in your browser",
    "view in browser",
    "view in your browser",
    "all rights reserved",
    "registered trademark",
    "©",
  ],
  es: [
    "darte de baja",
    "darse de baja",
    "cancelar la suscripción",
    "cancelar tu suscripción",
    "anular la suscripción",
    "recibes este correo",
    "has recibido este correo",
    "recibiste este correo",
    "este correo fue enviado a",
    "este correo está dirigido a",
    "este mensaje fue enviado a",
    "preferencias de correo",
    "preferencias de notificaciones",
    "ver en el navegador",
    "todos los derechos reservados",
    "marca registrada",
    "marcas registradas",
  ],
};
