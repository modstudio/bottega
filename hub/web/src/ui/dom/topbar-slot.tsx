import { createContext, useContext } from 'react'

const TopbarSlot = createContext<HTMLElement | null>(null)

/** The element in the app's top bar that a page header renders into, when the shell offers one. */
export const TopbarSlotProvider = TopbarSlot.Provider

export function useTopbarSlot() {
  return useContext(TopbarSlot)
}
