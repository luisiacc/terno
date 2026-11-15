/**
 * Plan 210 (the Codex code review of prompt v11, points 3 and 7): whether some words of a mail say a given day or a clock time,
 * in English or Spanish. Not a date parser: it reads the ways a mail names a day (a weekday, "November 20", "20 de
 * noviembre", "11/20", "the 20th", "el día 20", "tomorrow", "end of the month", "this week") and says whether one of them is
 * that day. A move's evidence must say its day, and a move of the time alone is told from one that names its date. Pure.
 */

const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MONTHS: [RegExp, number][] = [
  [/^(?:jan(?:uary)?|ene(?:ro)?)$/, 1],
  [/^(?:feb(?:ruary|rero)?)$/, 2],
  [/^(?:mar(?:ch|zo)?)$/, 3],
  [/^(?:apr(?:il)?|abr(?:il)?)$/, 4],
  [/^(?:may|mayo)$/, 5],
  [/^(?:jun(?:e|io)?)$/, 6],
  [/^(?:jul(?:y|io)?)$/, 7],
  [/^(?:aug(?:ust)?|ago(?:sto)?)$/, 8],
  [/^(?:sep(?:t(?:ember)?)?|sept?iembre|setiembre)$/, 9],
  [/^(?:oct(?:ober|ubre)?)$/, 10],
  [/^(?:nov(?:ember|iembre)?)$/, 11],
  [/^(?:dec(?:ember)?|dic(?:iembre)?)$/, 12],
];
const monthOf = (word: string) => MONTHS.find(([re]) => re.test(word))?.[1] ?? null;

type Said = { weekday: number } | { month: number; day: number; year?: number } | { day: number } | { offset: number } | { monthEnd: true } | { withinDays: number };

const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const MONTH_WORD = String.raw`[a-z]{3,10}\.?`;

/** The days some words name, as they name them. `relative`: "today", "tomorrow", "this week" (they need the day the mail came). */
function daysSaid(words: string, relative: boolean): Said[] {
  const t = plain(words);
  const out: Said[] = [];
  for (const m of t.matchAll(/\b([a-z]+)\b/g)) if (WEEKDAYS[m[1]!] !== undefined) out.push({ weekday: WEEKDAYS[m[1]!]! });
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.push({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  // "November 20", "Nov. 20th"
  for (const m of t.matchAll(new RegExp(String.raw`\b(${MONTH_WORD})\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g"))) {
    const month = monthOf(m[1]!.replace(".", ""));
    if (month) out.push({ month, day: Number(m[2]) });
  }
  // "20 November", "20 de noviembre", "20th of November"
  for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+|of\s+)?(${MONTH_WORD})`, "g"))) {
    const month = monthOf(m[2]!.replace(".", ""));
    if (month) out.push({ month, day: Number(m[1]) });
  }
  // "11/20", "20/11", "20.11.2026": either order
  for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.]\d{2,4})?\b/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    out.push({ month: a, day: b }, { month: b, day: a });
  }
  // "the 20th", "on the 20", "el 20", "el día 20", "día 20"
  for (const m of t.matchAll(/\b(?:(?:on )?the|el(?: dia)?|dia)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?::|[ap]\.?m\b|h\b|hours?|horas?|minutes?|minutos?|%))/g)) out.push({ day: Number(m[1]) });
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) out.push({ day: Number(m[1]) });
  if (/\b(?:end of (?:the )?month|month[- ]end|fin(?:al)? de(?:l)? mes)\b/.test(t)) out.push({ monthEnd: true });
  if (relative) {
    if (/\b(?:today|tonight|hoy|esta noche)\b/.test(t)) out.push({ offset: 0 });
    // "mañana" is tomorrow, unless it's a morning ("el lunes por la mañana")
    if (/\btomorrow\b|(?<!la )\bmanana\b/.test(t)) out.push({ offset: 1 });
    if (/\bpasado manana\b/.test(t)) out.push({ offset: 2 });
    if (/\b(?:this|next) week(?:end)?\b|\besta semana\b|\b(?:la )?(?:proxima|siguiente) semana\b|\bfin de semana\b/.test(t)) out.push({ withinDays: 13 });
  }
  return out;
}

const dayOf = (due: string) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  return d ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))) : null;
};
const localDayStart = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * Whether some words name `due` (YYYY-MM-DD), or a day within `slack` of it: a time given in another zone lands a day either
 * side, and "before Monday" is the Sunday. `arrivedAt` lets "today", "tomorrow" and "this week" count.
 */
export function saysDay(words: string, due: string, o: { slack?: number; arrivedAt?: number; weekdays?: boolean } = {}): boolean {
  const target = dayOf(due);
  if (!target) return false;
  // `weekdays: false`: only a date ("November 19"), when a weekday names more than one week's day
  const said = daysSaid(words, o.arrivedAt !== undefined).filter((s) => o.weekdays !== false || !("weekday" in s));
  if (!said.length) return false;
  const slack = o.slack ?? 0;
  const arrived = o.arrivedAt !== undefined ? localDayStart(o.arrivedAt) : null;
  for (let k = -slack; k <= slack; k++) {
    const c = new Date(target.getTime() + k * 86_400_000);
    const [y, mo, d, wd] = [c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), c.getUTCDay()];
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const fromArrival = arrived === null ? null : Math.round((c.getTime() - arrived) / 86_400_000);
    for (const s of said) {
      if ("weekday" in s && s.weekday === wd) return true;
      if ("month" in s && s.month === mo && s.day === d && (s.year === undefined || s.year === y)) return true;
      if ("day" in s && !("month" in s) && s.day === d) return true;
      if ("monthEnd" in s && d === last) return true;
      if ("offset" in s && fromArrival === s.offset) return true;
      if ("withinDays" in s && fromArrival !== null && fromArrival >= 0 && fromArrival <= s.withinDays) return true;
    }
  }
  return false;
}

/** Whether some words give a clock time: "8:00", "8 AM", "10 p.m.", "20 h", "noon", "a las 8", "mediodía". */
export function saysClock(words: string): boolean {
  return /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:a\.?\s?m\b|p\.?\s?m\b)|\b\d{1,2}\s?h\b|\b(?:noon|midnight|mediodia|medianoche)\b|\ba las? \d{1,2}\b/.test(plain(words));
}
