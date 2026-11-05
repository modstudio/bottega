import { createContext, type ReactNode, useContext } from 'react'

export type ControlSize = 'sm' | 'md'

const ControlSizeContext = createContext<ControlSize | undefined>(undefined)

/**
 * One size for every control inside a band, such as a table's toolbar, so a control
 * added later cannot change the band's height. A control's own `size` still wins.
 */
export function ControlSizeProvider({
  size,
  children,
}: {
  size: ControlSize
  children: ReactNode
}) {
  return <ControlSizeContext.Provider value={size}>{children}</ControlSizeContext.Provider>
}

/** The size a control renders at: its own, else the surrounding band's, else its default. */
export function useControlSize<T extends string>(own: T | undefined, fallback: T): T | ControlSize {
  const band = useContext(ControlSizeContext)
  return own ?? band ?? fallback
}
