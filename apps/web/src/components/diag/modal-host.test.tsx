// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@terno/ui/components/alert-dialog";
import { ModalHostProvider, useModalHost } from "@terno/ui/components/modal-host";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function CurrentHost() {
  const host = useModalHost();
  return <output data-testid="owner">{host?.dataset.testid ?? "none"}</output>;
}

function Tree({ parent, child }: { parent: boolean; child: boolean }) {
  return <ModalHostProvider><CurrentHost />
    <Dialog open={parent}><DialogContent data-testid="parent"><DialogTitle>Parent</DialogTitle>
      <AlertDialog open={child}><AlertDialogContent data-testid="child"><AlertDialogTitle>Child</AlertDialogTitle></AlertDialogContent></AlertDialog>
    </DialogContent></Dialog>
  </ModalHostProvider>;
}

it("tracks only open popup owners, restores the parent and survives StrictMode reopen", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const mounted = createRoot(root);
  const render = async (parent: boolean, child: boolean) => act(async () => mounted.render(<StrictMode><Tree parent={parent} child={child} /></StrictMode>));
  const owner = () => root.querySelector('[data-testid="owner"]')?.textContent;
  try {
    await render(false, false); expect(owner()).toBe("none");
    await render(true, false); expect(owner()).toBe("parent");
    await render(true, true); expect(owner()).toBe("child");
    await render(true, false); expect(owner()).toBe("parent");
    await render(false, false); expect(owner()).toBe("none");
    await render(true, false); expect(owner()).toBe("parent");
  } finally { await act(async () => mounted.unmount()); root.remove(); }
});
