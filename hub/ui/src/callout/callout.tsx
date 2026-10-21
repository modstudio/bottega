import type { ReactNode } from 'react'
import type { Tone } from '../badge/badge'
import { calloutStyles } from './callout.styles.ts'

/**
 * A labeled note region. Tone selects the status role through `data-tone`;
 * the title is the kind in text, so the kind never depends on color alone.
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
    <aside role="note" data-tone={tone} className={calloutStyles().root()}>
      <div className={calloutStyles().title()}>{title}</div>
      <div className={calloutStyles().body()}>{children}</div>
    </aside>
  )
}
