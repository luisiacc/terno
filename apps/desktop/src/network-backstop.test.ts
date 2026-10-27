import { describe, expect, it } from "vitest";
import { backstopAllows, isLoopbackHost, isMailFrame, originOf, requestFrame, type FrameLike, type RequestFrame } from "./network-backstop";

const app = ["app://terno"];
const mail: RequestFrame = { url: "about:srcdoc", parentIsTop: true, topUrl: "app://terno/index.html" };
const image = (frame: RequestFrame | null, url = "https://images.acme.test/promo.png") => ({ url, resourceType: "image", frame });
const local = { localMode: true, appOrigins: app };

describe("main: the renderer's network backstop", () => {
  it("loopback is always reachable; outside local mode everything is", () => {
    for (const url of ["http://127.0.0.1:5173/x.js", "http://localhost:11434/v1", "ws://[::1]:9000/", "http://127.4.5.6/"]) expect(backstopAllows({ url, resourceType: "xhr", frame: null }, local)).toBe(true);
    expect(backstopAllows({ url: "https://api.example.test/", resourceType: "xhr", frame: null }, { localMode: false, appOrigins: app })).toBe(true);
    expect(isLoopbackHost("localhost.evil.test")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  it("plan 35: in local mode an image a mail frame asks for passes (the frame's CSP is the per-message gate)", () => {
    expect(backstopAllows(image(mail), local)).toBe(true);
    expect(backstopAllows(image(mail, "http://tracker.test/pixel.gif"), local)).toBe(true);
    // the dev renderer's page is a mail frame's top too
    expect(backstopAllows(image({ ...mail, topUrl: "http://localhost:5173/" }), { localMode: true, appOrigins: [...app, "http://localhost:5173"] })).toBe(true);
  });

  it("in local mode nothing but images passes, even from a mail frame", () => {
    for (const resourceType of ["script", "xhr", "webSocket", "stylesheet", "font", "media", "ping", "cspReport", "subFrame", "mainFrame", "object", "other"]) {
      expect(backstopAllows({ url: "https://cdn.test/x", resourceType, frame: mail }, local)).toBe(false);
    }
    expect(backstopAllows({ url: "wss://socket.test/", resourceType: "webSocket", frame: mail }, local)).toBe(false);
  });

  it("in local mode an image from anywhere but a mail frame is cancelled", () => {
    // the app's own page, a frame that navigated or is gone, a nested frame, a child that isn't srcdoc, a foreign top
    expect(backstopAllows(image({ url: "app://terno/", parentIsTop: false, topUrl: "app://terno/" }), local)).toBe(false);
    expect(backstopAllows(image(null), local)).toBe(false);
    expect(backstopAllows(image({ ...mail, parentIsTop: false }), local)).toBe(false);
    expect(backstopAllows(image({ ...mail, url: "about:blank" }), local)).toBe(false);
    expect(backstopAllows(image({ ...mail, url: "https://evil.test/" }), local)).toBe(false);
    // the top's origin, exactly: no prefix games
    expect(backstopAllows(image({ ...mail, topUrl: "https://evil.test/app://terno/" }), local)).toBe(false);
    expect(backstopAllows(image({ ...mail, topUrl: "app://terno.evil.test/" }), local)).toBe(false);
    expect(backstopAllows(image({ ...mail, topUrl: "http://localhost:51730/" }), { localMode: true, appOrigins: [...app, "http://localhost:5173"] })).toBe(false);
    expect(isMailFrame({ ...mail, topUrl: "https://evil.test/" }, [""])).toBe(false);
    expect(isMailFrame({ ...mail, topUrl: "not a url" }, app)).toBe(false);
    expect(originOf("app://terno/a/b?c")).toBe("app://terno");
    expect(originOf("http://localhost:5173/x")).toBe("http://localhost:5173");
    expect(originOf("about:srcdoc")).toBe(null);
  });

  it("an unreadable URL is cancelled in either mode", () => {
    expect(backstopAllows({ url: "http://[bad", resourceType: "image", frame: mail }, local)).toBe(false);
    expect(backstopAllows({ url: "http://[bad", resourceType: "image", frame: mail }, { localMode: false, appOrigins: app })).toBe(false);
  });

  it("reads Electron's frame fail-closed: missing, detached, orphaned or disposed frames are unknown", () => {
    const top: FrameLike = { url: "app://terno/", frameTreeNodeId: 1, parent: null, get top() { return top; } };
    const child: FrameLike = { url: "about:srcdoc", frameTreeNodeId: 2, parent: top, top };
    const grandchild: FrameLike = { url: "about:srcdoc", frameTreeNodeId: 3, parent: child, top };
    expect(requestFrame(child)).toEqual({ url: "about:srcdoc", parentIsTop: true, topUrl: "app://terno/" });
    expect(requestFrame(grandchild)).toMatchObject({ parentIsTop: false });
    // the top frame itself has no parent
    expect(requestFrame(top)).toBe(null);
    expect(requestFrame(undefined)).toBe(null);
    expect(requestFrame(null)).toBe(null);
    expect(requestFrame({ ...child, detached: true })).toBe(null);
    expect(requestFrame({ ...child, top: null })).toBe(null);
    const disposed = { frameTreeNodeId: 2, parent: top, top, get url(): string { throw new Error("Render frame was disposed"); } };
    expect(requestFrame(disposed)).toBe(null);
    // and what it reads, the backstop judges
    expect(backstopAllows(image(requestFrame(child)), local)).toBe(true);
    expect(backstopAllows(image(requestFrame(grandchild)), local)).toBe(false);
    expect(backstopAllows(image(requestFrame(disposed)), local)).toBe(false);
  });
});
