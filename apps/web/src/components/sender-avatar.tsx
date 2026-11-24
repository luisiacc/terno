import { cn } from "@terno/ui/lib/utils";
import { memo, useRef, useState } from "react";
import { avatarColor, initials } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { iconFailed, iconStandsFor, useSenderIcon } from "~/lib/sender-icons";

/** A person's initials on their color's faint tint, quieter than the mail beside them: the ink holds 4.5:1 on that tint wherever avatars sit (rows, drafts, the reader). */
const TINT: Record<ReturnType<typeof avatarColor>, string> = {
  rose: "bg-cat-rose/10 text-cat-rose-ink",
  amber: "bg-cat-amber/10 text-cat-amber-ink",
  lime: "bg-cat-lime/10 text-cat-lime-ink",
  emerald: "bg-cat-emerald/10 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/10 text-cat-cyan-ink",
  brown: "bg-cat-brown/10 text-cat-brown-ink",
  violet: "bg-cat-violet/10 text-cat-violet-ink",
  slate: "bg-cat-slate/10 text-cat-slate-ink",
};

/**
 * Initials, and over them (plan 22) the sender's icon once there is one: a
 * Google photo or a website icon, fetched by the backend only when the user's
 * settings allow. A plain span, cheap enough for every list row; size and
 * type come from the caller (design variables). The icon lives in its own
 * memoized child, so one arriving re-renders that child, never the row.
 * `person` (plan 158): someone writing from a company's domain is that person, not the company: their photo or their
 * initials, never the company's logo on five different people. `drawn`: the initials are drawn, not text, for an avatar
 * inside words (What matters' sentence), which then read, match and copy without them.
 */
export function SenderAvatar({ name, email, className, icon = false, person = false, drawn = false }: { name: string; email: string; className?: string; icon?: boolean; person?: boolean; drawn?: boolean }) {
  const letters = initials(name || email);
  return (
    <span aria-hidden data-testid="sender-avatar" className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium select-none", TINT[avatarColor(email)], className)}>
      {drawn ? <span data-initials={letters} className="leading-none before:content-[attr(data-initials)]" /> : letters}
      {icon && <SenderIcon email={email} person={person} />}
    </span>
  );
}

/** Plan 252: a mark's longer side, as a share of the disc */
const MARK = 0.62;
/** below this many of its own pixels across, what an icon draws is too coarse to fill the disc: it stays a mark */
const FILL_MIN_PX = 32;
/** a mark is never drawn smaller than this, on the smallest avatars (What matters' sentence) */
const MARK_MIN_PX = 14;

/**
 * The icon layer: always there (it's what the visibility observer watches), empty until an icon
 * arrives. A photo fills the circle. A website's icon is drawn by what it shows (plan 252), its own
 * padding trimmed: a circle, or a square whose mark sits inside the circle, fills the disc (a hairline
 * when its edge is white or black); anything else is a mark on a muted plate, the same disc and size as
 * initials, at no more than twice its own pixels so a 16 px one stays crisp. A faint halo keeps a dark
 * mark's edge on that plate. It fades in (within --motion) only when it arrives after the avatar showed;
 * one already loaded shows at once (scrolling back through a list doesn't flicker).
 */
const SenderIcon = memo(function SenderIcon({ email, person }: { email: string; person: boolean }) {
  renderProbe("SenderIcon");
  const ref = useRef<HTMLSpanElement>(null);
  const found = useSenderIcon(email, ref, true);
  const icon = found && iconStandsFor(found.ref, person) ? found : null;
  // what the first render had: an icon there from the start never fades
  const [atMount] = useState(() => icon?.url ?? null);
  const [loaded, setLoaded] = useState(false);
  const fade = icon !== null && icon.url !== atMount;
  const photo = icon?.ref.kind === "photo";
  // the drawn part's own pixels, not the image's: a small circle in a padded favicon is still small
  const fill = !photo && icon !== null && icon.fit.fill && icon.ref.px * Math.min(icon.fit.box[2], icon.fit.box[3]) >= FILL_MIN_PX;
  return (
    <span
      ref={ref}
      data-testid={icon ? "sender-icon" : undefined}
      data-icon-kind={icon?.ref.kind}
      data-icon-fit={icon && !photo ? (fill ? "fill" : "mark") : undefined}
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden rounded-full",
        icon && !photo && "bg-muted",
        // over the image, so a white disc keeps its edge on a white card
        fill && icon.fit.ring && "after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_0_0_var(--hairline-w)_var(--border)]",
      )}
    >
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
          className={cn(photo ? "size-full object-cover" : "absolute top-1/2 left-1/2 aspect-square max-w-none object-contain", !photo && !fill && "dark:drop-shadow-[0_0_0.5px_var(--muted-foreground)]", fade && "transition-opacity duration-base", fade && !loaded && "opacity-0")}
          style={photo ? undefined : fill ? placed(icon.fit.box, "fill") : placed(icon.fit.box, "mark", Math.max(16, icon.ref.px) * 2)}
        />
      )}
    </span>
  );
});

/**
 * The image placed so its content box is centered on the disc: a fill's shorter side spans the disc (the crop
 * the classifier approved, no crescent left on a near square); a mark's longer side is MARK of it, at least
 * MARK_MIN_PX and at most `cap` px for the whole image (the two-times rule). Its width is in the disc's
 * percentages, then a translate in the image's own, which holds whatever the floor or cap made the width.
 */
function placed([x, y, w, h]: readonly number[], how: "fill" | "mark", cap = 0): React.CSSProperties {
  const side = how === "fill" ? Math.min(w!, h!) : Math.max(w!, h!);
  const size = `${(((how === "fill" ? 1 : MARK) / side) * 100).toFixed(2)}%`;
  return {
    width: how === "fill" ? size : `min(max(${size}, ${(MARK_MIN_PX / side).toFixed(2)}px), ${cap}px)`,
    transform: `translate(${(-(x! + w! / 2) * 100).toFixed(2)}%, ${(-(y! + h! / 2) * 100).toFixed(2)}%)`,
  };
}
