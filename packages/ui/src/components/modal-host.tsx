import * as React from "react"

type Register = (host: HTMLElement, depth: number) => () => void
const Registration = React.createContext<Register>(() => () => {})
const ActiveHost = React.createContext<HTMLElement | null>(null)
const Depth = React.createContext(0)

/** Tracks committed modal surfaces without importing any dialog implementation. */
export function ModalHostProvider({ children }: { children: React.ReactNode }) {
  const [hosts, setHosts] = React.useState<{ token: object; host: HTMLElement; depth: number }[]>([])
  const register = React.useCallback<Register>((host, depth) => {
    const token = {}
    setHosts((current) => [...current, { token, host, depth }])
    return () => setHosts((current) => current.filter((entry) => entry.token !== token))
  }, [])
  const host = hosts.reduce<(typeof hosts)[number] | null>((top, entry) => !top || entry.depth >= top.depth ? entry : top, null)?.host ?? null
  return <Registration.Provider value={register}><ActiveHost.Provider value={host}>{children}</ActiveHost.Provider></Registration.Provider>
}

export const useModalHost = () => React.useContext(ActiveHost)

/** Rendered by a popup's public render callback, which supplies its current open state. */
export function ModalHostPopup({ open, elementProps }: { open: boolean; elementProps: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> } }) {
  const register = React.useContext(Registration)
  const depth = React.useContext(Depth) + 1
  const [element, setElement] = React.useState<HTMLDivElement | null>(null)
  const forwarded = elementProps.ref
  const ref = React.useCallback((node: HTMLDivElement | null) => {
    setElement(node)
    if (typeof forwarded === "function") forwarded(node)
    else if (forwarded) forwarded.current = node
  }, [forwarded])
  React.useLayoutEffect(() => open && element ? register(element, depth) : undefined, [open, element, register, depth])
  return <Depth.Provider value={depth}><div {...elementProps} ref={ref} /></Depth.Provider>
}
