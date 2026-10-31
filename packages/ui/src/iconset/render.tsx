/**
 * Draws a Hugeicons icon (plan 92). Not @hugeicons/react: its paths carry stroke-width="1.5", which no CSS on the
 * <svg> can reach. Without it they take the design's line (globals.css: --icon-line, non-scaling).
 */
import type { ReactElement, Ref, SVGProps } from "react";

type IconNode = readonly (readonly [string, { readonly [key: string]: string | number }])[];
export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string; ref?: Ref<SVGSVGElement> };
export type Icon = (props: IconProps) => ReactElement;

export function icon(node: IconNode, name: string): Icon {
  const children = node.map(([Tag, { key, ...attrs }]) => {
    delete (attrs as { strokeWidth?: unknown }).strokeWidth;
    return <Tag key={key} {...attrs} />;
  });
  const C = ({ size = 24, className, ...rest }: IconProps) => {
    // decorative unless something names it (as lucide did)
    const named = rest["aria-label"] || rest["aria-labelledby"] || rest.role;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={named ? undefined : true}
        className={className ? `icon ${className}` : "icon"}
        {...rest}
      >
        {children}
      </svg>
    );
  };
  C.displayName = name;
  return C;
}

