import { parseMailLink } from "@terno/core/mail-link";

/**
 * Plan 201: links to emails (terno://message/…) reach main three ways: macOS's `open-url`, a cold start's arguments
 * (Linux, a dev or test run) and a second launch's (`second-instance`). Each is parsed here (anything else is
 * ignored) and held until the app can show it: one at a time, the newest wins.
 */
export class LinkReceiver {
  private held: string | null = null;
  private live = false;

  constructor(private readonly open: (id: string) => void) {}

  /** a URL the OS handed over */
  url(url: unknown): void {
    const id = parseMailLink(url);
    if (id) this.take(id);
  }

  /** a launch's arguments: the first that is a link */
  argv(argv: readonly unknown[]): void {
    for (const arg of argv) {
      const id = parseMailLink(arg);
      if (id) return this.take(id);
    }
  }

  /** a window exists: what came before goes now, and every later link at once */
  ready(): void {
    this.live = true;
    const id = this.held;
    this.held = null;
    if (id) this.open(id);
  }

  private take(id: string): void {
    if (this.live) this.open(id);
    else this.held = id;
  }
}

interface LinkSource {
  on(event: "open-url", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

/** Listens before the app is ready, so a link that launches Terno isn't lost (macOS sends it during launch). */
export function receiveLinks(app: LinkSource, argv: readonly string[], receiver: LinkReceiver): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receiver.url(url);
  });
  receiver.argv(argv);
}
