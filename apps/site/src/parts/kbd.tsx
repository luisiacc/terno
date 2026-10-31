/** A key as it reads on the keyboard. Styling is the design's: pass a className. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return <kbd className={className}>{children}</kbd>;
}
