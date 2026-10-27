/**
 * Main's fence around the renderer's own requests (plan 05, plan 35), kept
 * apart from Electron so it's unit-tested in Node. The backend polices its own
 * connections; this covers remote images, fonts, anything a mail or a bug
 * could load from the app's session.
 */

/** The frame a request came from, as main sees it; null when it navigated or is gone. */
export interface RequestFrame {
  url: string;
  /** a direct child of its window's top frame */
  parentIsTop: boolean;
  /** the window's top frame */
  topUrl: string;
}

/** The parts of Electron's WebFrameMain read here (a stand-in in tests). */
export interface FrameLike {
  readonly url: string;
  readonly detached?: boolean;
  readonly frameTreeNodeId: number;
  readonly parent: FrameLike | null;
  readonly top: FrameLike | null;
}

/** What main knows of a request's frame; null (so cancelled) when it's missing, detached, or throws on access (disposed under us). */
export function requestFrame(frame: FrameLike | null | undefined): RequestFrame | null {
  try {
    const parent = frame?.parent;
    const top = frame?.top;
    if (!frame || frame.detached || !parent || !top) return null;
    return { url: frame.url, parentIsTop: parent.frameTreeNodeId === top.frameTreeNodeId, topUrl: top.url };
  } catch {
    return null;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** scheme://host[:port], exactly; null for anything unparsable (Node gives custom schemes an opaque `origin`, so it's built by hand). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/**
 * A mail's frame: the reader's (or the print preview's) srcdoc child of the
 * app's own page, matched by exact origin. Mail can't make frames of its own
 * (frame-src 'none', and the sanitizer drops them), so nothing deeper qualifies.
 * This identifies the frame, not the consent: which images it may load is the
 * frame's CSP, built by the renderer from the user's choice.
 */
export function isMailFrame(frame: RequestFrame | null, appOrigins: readonly string[]): boolean {
  if (frame === null || frame.url !== "about:srcdoc" || !frame.parentIsTop) return false;
  const top = originOf(frame.topUrl);
  return top !== null && appOrigins.includes(top);
}

/**
 * Loopback is always reachable (backend-dev, local AI from a dev renderer).
 * Outside local mode everything else is too. In local mode only an image a
 * mail frame asks for passes (plan 35): the user loaded it, with "Load
 * content" or the setting, and the frame's CSP is that per-message gate
 * (img-src opens only for an approved message). Scripts, fetch/XHR, sockets,
 * stylesheets, fonts, media and anything from the app's own frame stay
 * cancelled; an unreadable URL or an unknown frame fails closed.
 */
export function backstopAllows(req: { url: string; resourceType: string; frame: RequestFrame | null }, o: { localMode: boolean; appOrigins: readonly string[] }): boolean {
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHost(host) || !o.localMode) return true;
  return req.resourceType === "image" && isMailFrame(req.frame, o.appOrigins);
}
