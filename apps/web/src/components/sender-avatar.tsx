import { cn } from "@terno/ui/lib/utils";
import { memo, useRef, useState } from "react";
import { avatarColor, initials } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { iconFailed, useSenderIcon } from "~/lib/sender-icons";

/** A person's initials on their color's soft tint: the ink holds 4.5:1 on that tint wherever avatars sit (rows, drafts, the reader). */
const TINT: Record<ReturnType<typeof avatarColor>, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  indigo: "bg-cat-indigo/15 text-cat-indigo-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
};

/**
 * Initials, and over them (plan 22) the sender's icon once there is one: a
 * Google photo or a website icon, fetched by the backend only when the user's
 * settings allow. A plain span, cheap enough for every list row; size and
 * type come from the caller (design variables). The icon lives in its own
 * memoized child, so one arriving re-renders that child, never the row.
 */
export function SenderAvatar({ name, email, className, icon = false }: { name: string; email: string; className?: string; icon?: boolean }) {
  return (
    <span aria-hidden data-testid="sender-avatar" className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none", TINT[avatarColor(email)], className)}>
      {initials(name || email)}
      {icon && <SenderIcon email={email} />}
    </span>
  );
}

/**
 * The icon layer: always there (it's what the visibility observer watches), empty until an icon
 * arrives. A photo or a touch icon fills the circle; a favicon sits on a paper tile at no more
 * than twice its own size, so a 16 px one stays small and crisp instead of stretched. It fades in
 * (within --motion) only when it arrives after the avatar showed; one already loaded shows at once
 * (scrolling back through a list doesn't flicker).
 */
const SenderIcon = memo(function SenderIcon({ email }: { email: string }) {
  renderProbe("SenderIcon");
  const ref = useRef<HTMLSpanElement>(null);
  const icon = useSenderIcon(email, ref, true);
  // what the first render had: an icon there from the start never fades
  const [atMount] = useState(() => icon?.url ?? null);
  const [loaded, setLoaded] = useState(false);
  const fade = icon !== null && icon.url !== atMount;
  const full = icon?.ref.full ?? false;
  return (
    <span ref={ref} data-testid={icon ? "sender-icon" : undefined} data-icon-kind={icon?.ref.kind} className={cn("pointer-events-none absolute inset-0 flex items-center justify-center rounded-full", icon && !full && "bg-[var(--mail-paper)] shadow-[inset_0_0_0_var(--hairline-w)_var(--hairline)]")}>
      {icon && (
        <img
          key={icon.url}
          src={icon.url}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => iconFailed(email)}
          className={cn(full ? "size-full object-cover" : "aspect-square object-contain", fade && "transition-opacity duration-base", fade && !loaded && "opacity-0")}
          style={full ? undefined : { width: `min(62%, ${Math.max(16, icon.ref.px) * 2}px)` }}
        />
      )}
    </span>
  );
});
