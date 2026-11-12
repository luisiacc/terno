import { describe, expect, it } from "vitest";
import { profileDir } from "./profile";

// plan 189: the MCP sidecar finds the app's socket and token where the app keeps its profile, on every platform
describe("the app's profile, as the MCP sidecar finds it", () => {
  it("is Application Support on macOS and ~/.config on Linux (Electron's appData), named Terno", () => {
    expect(profileDir({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/Terno");
    expect(profileDir({}, "linux", "/home/me")).toBe("/home/me/.config/Terno");
  });

  it("follows XDG_CONFIG_HOME on Linux, as Electron does, and TERNO_USER_DATA everywhere", () => {
    expect(profileDir({ XDG_CONFIG_HOME: "/data/conf" }, "linux", "/home/me")).toBe("/data/conf/Terno");
    expect(profileDir({ XDG_CONFIG_HOME: "" }, "linux", "/home/me")).toBe("/home/me/.config/Terno");
    expect(profileDir({ TERNO_USER_DATA: "/tmp/p", XDG_CONFIG_HOME: "/data/conf" }, "linux", "/home/me")).toBe("/tmp/p");
    expect(profileDir({ TERNO_USER_DATA: "/tmp/p" }, "darwin", "/Users/me")).toBe("/tmp/p");
  });
});
