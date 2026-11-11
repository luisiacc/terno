import type { SiteCopy } from "../copy";
import { Window } from "./window";

/** Each design's colors for the session; the layout is shared. */
export interface SessionStyle {
  /** the window's frame (its design's window class) */
  window: string;
  /** the text inside: color and background */
  body: string;
  /** "You", "Agent" */
  who: string;
  /** Terno's tool line */
  tool: string;
  /** the setup line and the tool's result */
  dim: string;
}

/**
 * Agents over MCP (plan 97, "AI agents"): an example session in a terminal window, written as text so it reads in
 * both languages and to a screen reader. The setup line is the real command, its path shortened; the tool is the
 * real one. Not a picture of any agent's own interface.
 */
export function AgentSession({ copy, s, className = "" }: { copy: SiteCopy; s: SessionStyle; className?: string }) {
  const d = copy.features.agents.demo;
  return (
    <figure className={className}>
      <Window className={s.window}>
        <div className={`grid gap-5 p-5 pt-10 font-mono text-[0.8rem] leading-relaxed sm:p-6 sm:pt-11 ${s.body}`}>
          <p className={`[overflow-wrap:anywhere] ${s.dim}`}>
            <span aria-hidden="true">$ </span>claude mcp add terno -- /Applications/Terno.app/…/<wbr />terno-mcp
          </p>
          <div>
            <p className={s.who}>{d.you}</p>
            <p className="mt-1">{d.ask}</p>
          </div>
          <p className={s.tool}>
            terno · search_emails <span>“{d.query}”</span>
            <span className={`block ${s.dim}`}>
              <span aria-hidden="true">→ </span>
              {d.found}
            </span>
          </p>
          <div>
            <p className={s.who}>{d.agent}</p>
            <p className="mt-1">{d.answer}</p>
          </div>
        </div>
      </Window>
    </figure>
  );
}

/** The privacy page's section on agents, named as its heading. */
export function agentsPrivacyLink(copy: SiteCopy) {
  const page = copy.lang === "es" ? "/es/privacy/" : "/privacy/";
  const agents = copy.pages.privacy.sections.find((s) => s.id === "agents")!;
  return { href: `${page}#agents`, label: `${copy.nav.privacy} · ${agents.title}` };
}
