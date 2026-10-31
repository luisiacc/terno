import type { ReactNode } from "react";

/**
 * A macOS window around a screenshot: the shots are the app's content without the title bar, so this draws the
 * traffic lights. `className` styles the frame (radius, shadow, border); the lights are decorative.
 */
export function Window({ children, className = "", dark }: { children: ReactNode; className?: string; dark?: boolean }) {
  return (
    <div className={`site-window ${dark ? "site-window-dark" : ""} ${className}`}>
      <div className="site-window-bar" aria-hidden="true">
        <span style={{ background: "#ff5f57" }} />
        <span style={{ background: "#febc2e" }} />
        <span style={{ background: "#28c840" }} />
      </div>
      {children}
    </div>
  );
}
