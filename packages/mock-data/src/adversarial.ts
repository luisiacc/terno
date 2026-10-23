import type { Address } from "@unica/core";

/**
 * Shapes that break naive categorizers (plan 02 §9). Each family has a gold
 * label set: what a careful user would file the thread under.
 */
export const FAMILIES = ["amazon-invoice", "uber-promo", "phish-bank", "friend-trip", "client-invoice", "new-receipt", "fintech-newsletter"] as const;
export type AdversarialFamily = (typeof FAMILIES)[number];

/** Share of threads per family (relative to options.threads). */
export const FAMILY_SHARE: Record<AdversarialFamily, number> = {
  "amazon-invoice": 0.008,
  "uber-promo": 0.013,
  "phish-bank": 0.01,
  "friend-trip": 0.01,
  "client-invoice": 0.008,
  "new-receipt": 0.007,
  "fintech-newsletter": 0.01,
};

export interface FamilyMessage {
  from: Address;
  fromMe: boolean;
  subject: string;
  bodyText: string;
  listId: string | null;
  isSpam: boolean;
  attachments: { filename: string; mime: string; size: number }[];
}

export interface FamilyContext {
  pick<T>(list: readonly T[]): T;
  int(min: number, max: number): number;
  chance(p: number): boolean;
  friends: readonly Address[];
  person(): Address;
  clients: readonly { name: string; domain: string }[];
  projects: readonly string[];
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const money = (c: FamilyContext, min: number, max: number) => `$${c.int(min, max).toLocaleString("en-US")}.${String(c.int(0, 99)).padStart(2, "0")}`;
const pdf = (c: FamilyContext, name: string) => [{ filename: name, mime: "application/pdf", size: c.int(40_000, 300_000) }];
const msg = (m: Partial<FamilyMessage> & Pick<FamilyMessage, "from" | "subject" | "bodyText">): FamilyMessage => ({ fromMe: false, listId: null, isSpam: false, attachments: [], ...m });

/** Gold tags per family (mapped to categories through MOCK_CATEGORIES). */
export const FAMILY_TAGS = {
  "amazon-invoice": ["receipt"],
  "uber-promo": ["promo"],
  "phish-bank": ["phish"],
  "friend-trip": ["personal"],
  "client-invoice": ["client", "receipt"],
  "new-receipt": ["receipt"],
  "fintech-newsletter": ["newsletter"],
} as const;

export function familyThread(family: AdversarialFamily, c: FamilyContext): FamilyMessage[] {
  switch (family) {
    case "amazon-invoice": {
      // same sender as Amazon's shipping notices, which nobody files
      const order = `${c.int(100, 999)}-${c.int(1_000_000, 9_999_999)}`;
      return [
        msg({
          from: { name: "Amazon México", email: "pedidos@amazon.com.mx" },
          subject: c.pick([`Factura electrónica (CFDI) de tu pedido ${order}`, `Tu factura del pedido ${order} está lista`, `CFDI disponible: pedido ${order}`]),
          bodyText: `Adjuntamos la factura electrónica (CFDI) de tu pedido ${order}. Total facturado: ${money(c, 200, 9000)} MXN. RFC receptor registrado. Conserva este comprobante fiscal.`,
          attachments: pdf(c, `CFDI-${order}.pdf`),
        }),
      ];
    }
    case "uber-promo":
      return [
        msg({
          from: { name: "Uber", email: "promociones@uber.com" },
          subject: c.pick(["Hasta 30% de descuento en tu próximo viaje", "Tu próximo viaje con Uber Comfort va por nuestra cuenta", "Viaja más este fin de semana", "Nuevo: viajes programados en tu ciudad"]),
          bodyText: c.pick([
            "Usa el código VERANO25 en tus próximos viajes. Promoción válida hasta el domingo. Aplican términos y condiciones.",
            "Programa tu viaje al aeropuerto con anticipación y llega tranquilo. Descarga la versión más reciente de la app.",
            "Este fin de semana tus viajes tienen descuento. Abre la app y aplica la promoción automáticamente.",
          ]),
        }),
      ];
    case "phish-bank": {
      const bank = c.pick([
        { name: "BBVA", email: "alertas@bbva-mx-seguridad.com" },
        { name: "BBVA México", email: "soporte@bbvamx-alertas.click" },
        { name: "Banco Andino", email: "notificaciones@bancoandino-co.top" },
        { name: "Banco Andino Seguridad", email: "seguridad@andino-verifica.biz" },
      ]);
      return [
        msg({
          from: bank,
          subject: c.pick([`Cargo por ${money(c, 3000, 20000)} en tu tarjeta`, "Tu cuenta será suspendida", "Movimiento inusual detectado", "Actualiza tus datos para evitar el bloqueo"]),
          bodyText: `Se realizó un movimiento por ${money(c, 3000, 20000)} MXN. Si no reconoces este cargo, verifica tu cuenta de inmediato en el siguiente enlace o tu tarjeta será bloqueada.`,
          isSpam: c.chance(0.5),
        }),
      ];
    }
    case "friend-trip": {
      const friend = c.pick(c.friends);
      const city = c.pick(["Cancún", "Oaxaca", "Madrid", "Lima", "Bogotá"]);
      const thread = [
        msg({
          from: friend,
          subject: c.pick([`¿Vuelo a ${city} en diciembre?`, `Viaje a ${city} 🏖️`, `Plan: ${city} en el puente`]),
          bodyText: `Vi vuelos baratos a ${city} para diciembre, ¿reservamos? Podemos llegar al aeropuerto temprano y buscar hospedaje cerca del centro. Avísame qué opinas.`,
        }),
      ];
      if (c.chance(0.7)) thread.push(msg({ from: friend, fromMe: true, subject: `Re: ${thread[0]!.subject}`, bodyText: "¡Me encanta la idea! Reviso fechas y te digo." }));
      return thread;
    }
    case "client-invoice": {
      const client = c.pick(c.clients);
      const p = c.person();
      return [
        msg({
          from: { name: `${p.name} (${client.name})`, email: `${p.email.split("@")[0]}@${client.domain}` },
          subject: `Factura de ${c.pick(c.projects)} — ${c.pick(MONTHS)}`,
          bodyText: `Te comparto la factura correspondiente a este mes. Total: ${money(c, 4000, 60000)} MXN más IVA. Quedo atento a la confirmación del pago.`,
          attachments: pdf(c, `factura-${c.int(100, 999)}.pdf`),
        }),
      ];
    }
    case "new-receipt": {
      const src = c.pick([
        { name: "Netflix", email: "info@account.netflix.com", what: "tu membresía" },
        { name: "CFE", email: "recibos@cfe.mx", what: "tu consumo de luz" },
        { name: "Spotify", email: "no-reply@spotify.com", what: "Spotify Premium" },
      ]);
      const amount = money(c, 99, 1500);
      return [
        msg({
          from: { name: src.name, email: src.email },
          subject: `Tu recibo de ${src.name} · ${amount} MXN`,
          bodyText: `Gracias por tu pago de ${src.what}. Total: ${amount} MXN. Factura ${c.int(1000, 99999)} disponible.`,
        }),
      ];
    }
    case "fintech-newsletter":
      return [
        msg({
          from: { name: "Finanzas Claras", email: "boletin@finanzasclaras.mx" },
          listId: "boletin.finanzasclaras.mx",
          subject: c.pick(["Cómo deducir tus facturas este año", "Tu factura, tu dinero: guía rápida del CFDI", "5 errores al pedir factura", "¿Cuánto pagas de comisiones? Haz la cuenta"]),
          bodyText: `Esta semana: guarda cada factura y cada CFDI, revisa tu estado de cuenta y no pagues ${money(c, 100, 900)} de más en comisiones. Darse de baja: https://boletin.finanzasclaras.mx/u`,
        }),
      ];
  }
}
