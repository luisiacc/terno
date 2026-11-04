// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@terno/ui/components/dialog"
import { clampSpot } from "@terno/ui/lib/dialog-move"

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)

const sheet = { width: 820, height: 640 }

it("leaves the middle and anywhere inside alone", () => {
  const view = { width: 1400, height: 900 }
  expect(clampSpot({ x: 0, y: 0 }, sheet, view)).toEqual({ x: 0, y: 0 })
  expect(clampSpot({ x: 200, y: -100 }, sheet, view)).toEqual({ x: 200, y: -100 })
})

it("keeps a part in view on every side, and the top edge in the window", () => {
  const view = { width: 1400, height: 900 }
  // 120 px still showing at each side
  const right = clampSpot({ x: 9999, y: 0 }, sheet, view).x
  expect(view.width / 2 + right - sheet.width / 2).toBe(view.width - 120)
  const left = clampSpot({ x: -9999, y: 0 }, sheet, view).x
  expect(view.width / 2 + left + sheet.width / 2).toBe(120)
  // the top edge at the window's top, and 48 px above its bottom
  const up = clampSpot({ x: 0, y: -9999 }, sheet, view).y
  expect(view.height / 2 + up - sheet.height / 2).toBe(0)
  const down = clampSpot({ x: 0, y: 9999 }, sheet, view).y
  expect(view.height / 2 + down - sheet.height / 2).toBe(view.height - 48)
})

it("still moves in a window barely wider than the dialog", () => {
  const { x } = clampSpot({ x: 500, y: 0 }, sheet, { width: 860, height: 700 })
  expect(x).toBe(500)
})

it("a press in a portalled child doesn't move the dialog it bubbles to", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const mounted = createRoot(root)
  const capture = vi.fn()
  HTMLElement.prototype.setPointerCapture = capture
  await act(async () => mounted.render(
    <Dialog open>
      <DialogContent movable="unit-parent" data-testid="parent">
        <DialogHeader data-testid="parent-header"><DialogTitle>Parent</DialogTitle></DialogHeader>
        <Dialog open>
          <DialogContent data-testid="child"><DialogHeader data-testid="child-header"><DialogTitle>Child</DialogTitle></DialogHeader></DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  ))
  try {
    const press = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse" }))
    await act(async () => { press(document.querySelector('[data-testid=child-header]')!) })
    expect(capture).not.toHaveBeenCalled()
    await act(async () => { press(document.querySelector('[data-testid=parent-header]')!) })
    expect(capture).toHaveBeenCalledOnce()
  } finally {
    await act(async () => mounted.unmount())
    root.remove()
  }
})
