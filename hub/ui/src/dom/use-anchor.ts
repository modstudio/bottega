import { type CSSProperties, useId } from 'react'

/**
 * A CSS anchor pair: the trigger gets `anchor-name`, the popup `position-anchor`.
 * Placement itself is CSS (`position-area`), so the browser flips at the edges.
 */
export function useAnchor() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const name = `--anchor-${id}`
  return {
    id,
    anchorStyle: { anchorName: name } as CSSProperties,
    positionedStyle: { positionAnchor: name } as CSSProperties,
  }
}
