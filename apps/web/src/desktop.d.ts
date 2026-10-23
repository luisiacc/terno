export interface DesktopBridge {
  platform: string;
  version: string;
  openExternal(url: string): void;
  agentInfo(): Promise<{ mcpCommand: string; socketPath: string; skillPath: string }>;
}

declare global {
  interface Window {
    unicaDesktop?: DesktopBridge;
  }
}
