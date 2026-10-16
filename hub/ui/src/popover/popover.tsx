import {
  cloneElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type ToggleEvent,
  useState,
} from 'react'
import { useAnchor } from '../dom/use-anchor'
import { classes } from '../text/classes'
import { type Align, panelClasses, placementClasses, type Side } from './placement'

type TriggerProps = {
  popoverTarget?: string
  style?: React.CSSProperties
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'dialog'
}

/**
 * Anchored content that opens from a trigger and closes on outside click or
 * Escape, both handled by the browser's popover. `label` names the panel.
 */
export function Popover({
  trigger,
  label,
  side = 'bottom',
  align = 'start',
  onOpenChange,
  ref,
  children,
}: {
  trigger: ReactElement<TriggerProps>
  label: string
  side?: Side
  align?: Align
  onOpenChange?: (open: boolean) => void
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  const { id, anchorStyle, positionedStyle } = useAnchor()
  const [open, setOpen] = useState(false)
  return (
    <>
      {cloneElement(trigger, {
        popoverTarget: id,
        style: { ...trigger.props.style, ...anchorStyle },
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
      })}
      <div
        ref={ref}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        style={positionedStyle}
        onToggle={(event: ToggleEvent<HTMLDivElement>) => {
          const next = event.newState === 'open'
          setOpen(next)
          onOpenChange?.(next)
        }}
        className={classes(placementClasses(side, align), panelClasses, 'max-w-sm p-3')}
      >
        {children}
      </div>
    </>
  )
}
