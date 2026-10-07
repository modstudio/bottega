import type { ReactNode } from 'react'
import type { Tone } from '../badge/badge'

/**
 * A labelled note region. Tone selects the status role through `data-tone`;
 * the title is the kind in text, so the kind never depends on colour alone.
 */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: Tone
  title: string
  children?: ReactNode
}) {
  return (
    <aside role="note" data-tone={tone} className="border border-status-border bg-status-surface px-4 py-3">
      <div className="font-medium text-sm text-status-text">{title}</div>
      <div className="text-sm text-text-secondary">{children}</div>
    </aside>
  )
}
