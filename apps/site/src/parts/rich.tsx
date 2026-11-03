import type { ReactNode } from "react";

/**
 * The privacy page's copy keeps its few marks inline, so a translation moves them with the words: `**strong**`,
 * `` `code` `` and `[label](href)`. Nothing else is markup; an external link opens in place like every other link.
 */
const MARK = /\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\)/g;

export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MARK)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<strong key={key} className="font-semibold text-(--plain-fg)">{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key} className="rounded-md bg-white/8 px-1.5 py-0.5 font-mono text-[0.9em] text-(--plain-fg)">{m[2]}</code>);
    else
      out.push(
        <a key={key} href={m[4]} className="text-(--plain-fg) underline decoration-(--plain-line) underline-offset-4 hover:decoration-(--plain-fg)">
          {m[3]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
