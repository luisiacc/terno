import { cn } from "../lib/utils";

/**
 * Plan 276: the sign-in providers' own marks, as BoardUI's Social Button ships them (from SVG Logos, CC0) for its outlined
 * appearance, Microsoft's squares softened (the owner's pick). A company's mark isn't an icon: it keeps its colors in every
 * palette and both modes, and lives here, never in @terno/ui/icons. Decorative: the button beside it says the provider's name.
 */
type MarkProps = { className?: string };

function mark(name: string, viewBox: string, shapes: readonly { d: string; fill: string }[]) {
  const Mark = ({ className }: MarkProps) => (
    <svg viewBox={viewBox} className={cn("shrink-0", className)} aria-hidden focusable="false" data-provider-mark={name}>
      {shapes.map((s) => (
        <path key={s.fill} d={s.d} fill={s.fill} />
      ))}
    </svg>
  );
  // named, so Button's `loading` knows it for the leading icon and puts its spinner there (the label stays)
  Mark.displayName = `${name}Mark`;
  return Mark;
}

export const GoogleMark = mark("Google", "0 0 256 262", [
  { fill: "#4285f4", d: "M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622l38.755 30.023l2.685.268c24.659-22.774 38.875-56.282 38.875-96.027" },
  { fill: "#34a853", d: "M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055c-34.523 0-63.824-22.773-74.269-54.25l-1.531.13l-40.298 31.187l-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1" },
  { fill: "#fbbc05", d: "M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82c0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602z" },
  { fill: "#eb4335", d: "M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0C79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251" },
]);

// the owner's pick (plan 276, option B): the four squares with soft corners and a wider gap, rounder beside Google's G
export const MicrosoftMark = mark("Microsoft", "0 0 256 256", [
  { fill: "#f1511b", d: "M0 34a34 34 0 0 1 34-34h50a34 34 0 0 1 34 34v50a34 34 0 0 1-34 34H34A34 34 0 0 1 0 84z" },
  { fill: "#80cc28", d: "M138 34a34 34 0 0 1 34-34h50a34 34 0 0 1 34 34v50a34 34 0 0 1-34 34h-50a34 34 0 0 1-34-34z" },
  { fill: "#00adef", d: "M0 172a34 34 0 0 1 34-34h50a34 34 0 0 1 34 34v50a34 34 0 0 1-34 34H34A34 34 0 0 1 0 222z" },
  { fill: "#fbbc09", d: "M138 172a34 34 0 0 1 34-34h50a34 34 0 0 1 34 34v50a34 34 0 0 1-34 34h-50a34 34 0 0 1-34-34z" },
]);
