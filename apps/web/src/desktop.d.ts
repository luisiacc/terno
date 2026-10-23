export interface DesktopBridge {
  platform: string;
  version: string;
  openExternal(url: string): void;
  agentInfo(): Promise<{ mcpCommand: string; socketPath: string; skillPath: string }>;
  /** native theme source, window background (#rrggbb) and sidebar vibrancy; older shells don't have it */
  setAppearance?(appearance: { themeSource: "system" | "light" | "dark"; background: string; vibrancy: boolean }): void;
}

declare global {
  interface Window {
    unicaDesktop?: DesktopBridge;
  }
}
