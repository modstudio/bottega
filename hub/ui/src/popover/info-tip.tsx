import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { infoTipStyles } from './info-tip.styles.ts'
import { Popover } from './popover'

/**
 * The explanation behind a heading, kept off the page until asked for. A page,
 * section or row names itself; why it exists and what it does open from this
 * mark, so the explanation never competes with the content it explains.
 */
export function InfoTip({
  children,
  label = 'About this',
}: {
  children: ReactNode
  label?: string
}) {
  return (
    <Popover
      label={label}
      trigger={
        <button type="button" aria-label={label} className={infoTipStyles().trigger()}>
          <CircleHelp aria-hidden size={14} />
        </button>
      }
    >
      <div className={infoTipStyles().prose()}>{children}</div>
    </Popover>
  )
}
