import { Outlet, useChildMatches } from '@tanstack/react-router'

/** The child route's record, for a list's panel slot; nothing while no record is open. */
export function useDetailPanel() {
  const open = useChildMatches().length > 0
  return open ? <Outlet /> : undefined
}
