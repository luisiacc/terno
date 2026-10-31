import type { SiteCopy } from "../copy";

export interface WaitlistClasses {
  form?: string;
  label?: string;
  input?: string;
  select?: string;
  button?: string;
  note?: string;
  status?: string;
}

const STATUSES = ["thanks", "invalid", "busy", "full", "error"] as const;

/**
 * The Windows/Linux waitlist (plan 96). A real form: without JS it posts and the Worker answers 303 to
 * /waitlist/#<status>, where `:target` shows the message (site.css). With JS (client.ts) it posts in place and
 * shows the same message in the live region. `platform` preselects (the /download/ page asks for Mac).
 */
export function Waitlist({ copy, id = "waitlist", platform = "windows", c = {} }: { copy: SiteCopy; id?: string; platform?: "windows" | "linux" | "mac"; c?: WaitlistClasses }) {
  const w = copy.waitlist;
  return (
    <form method="post" action="/api/waitlist" className={`site-waitlist ${c.form ?? ""}`} data-waitlist data-sending={w.sending} noValidate={false}>
      <input type="hidden" name="lang" value={copy.lang} />
      {/* a field people never see; a bot that fills it is thanked and ignored */}
      <div className="site-hp" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-email`} className={c.label}>
          {w.email}
        </label>
        <input id={`${id}-email`} name="email" type="email" required maxLength={254} autoComplete="email" placeholder={w.placeholder} className={c.input} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-platform`} className={c.label}>
          {w.platform}
        </label>
        <select id={`${id}-platform`} name="platform" defaultValue={platform} className={c.select}>
          <option value="windows">{w.platforms.windows}</option>
          <option value="linux">{w.platforms.linux}</option>
          <option value="mac">{w.platforms.mac}</option>
        </select>
      </div>
      <button type="submit" className={c.button}>
        {w.submit}
      </button>
      <p className={`site-waitlist-status ${c.status ?? ""}`} role="status" aria-live="polite" data-status></p>
      <div hidden data-messages>
        {STATUSES.map((s) => (
          <span key={s} data-message={s}>
            {w[s]}
          </span>
        ))}
      </div>
      <p className={c.note}>{w.note}</p>
    </form>
  );
}

/** The no-JS outcomes, shown by `:target` on /waitlist/ (site.css). */
export function WaitlistOutcomes({ copy, className = "" }: { copy: SiteCopy; className?: string }) {
  return (
    <div className="site-outcomes">
      {STATUSES.map((s) => (
        <p key={s} id={s} className={`site-outcome ${s === "thanks" ? "site-outcome-ok" : "site-outcome-error"} ${className}`}>
          {copy.waitlist[s]}
        </p>
      ))}
    </div>
  );
}
