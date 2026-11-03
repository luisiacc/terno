// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "./pagination";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

function Pager({ total }: { total: number }) {
  const [page, setPage] = useState(0);
  return <Pagination aria-label="Sent-copy recovery" page={page} pageSize={25} total={total} onPageChange={setPage} />;
}

describe("Pagination (plan 125)", () => {
  it("names itself and shows the range between Previous and Next", async () => {
    const host = await render(<Pager total={80} />);
    const nav = host.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Sent-copy recovery");
    const [previous, next] = [...nav.querySelectorAll("button")];
    expect(previous!.textContent).toBe("Previous");
    expect(next!.textContent).toBe("Next");
    expect(nav.textContent).toContain("1–25 of 80");
  });

  it("pages through to the last range; an end is unavailable but keeps focus", async () => {
    const host = await render(<Pager total={80} />);
    const [previous, next] = [...host.querySelectorAll("button")];
    expect(previous!.getAttribute("aria-disabled")).toBe("true");
    next!.focus();
    for (let i = 0; i < 3; i++) await act(async () => next!.click());
    expect(host.textContent).toContain("76–80 of 80");
    expect(next!.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(next);
    await act(async () => next!.click());
    expect(host.textContent).toContain("76–80 of 80");
    await act(async () => previous!.click());
    expect(host.textContent).toContain("51–75 of 80");
  });

  it("is nothing when everything fits on one page", async () => {
    const host = await render(<Pager total={25} />);
    expect(host.querySelector("nav")).toBeNull();
  });
});
