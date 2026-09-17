import { cloneElement, type ReactElement, useEffect, useRef } from 'react'
import { useAnchor } from '../dom/use-anchor'

const OPEN_DELAY_MS = 500
/** A tooltip opened within this window of another closing opens at once. */
const WARM_MS = 300
let lastClosedAt = 0

type TriggerProps = {
  title?: string
  style?: React.CSSProperties
  'aria-describedby'?: string
  onPointerEnter?: (event: React.PointerEvent) => void
  onPointerLeave?: (event: React.PointerEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
}

/**
 * A short description shown on hover or keyboard focus. Hover invokers are not
 * yet in every browser, so opening is ours; the top layer and placement are
 * the browser's.
 */
export function Tooltip({
  label,
  side = 'top',
  children,
}: {
  label: string
  side?: 'top' | 'bottom'
  children: ReactElement<TriggerProps>
}) {
  const { id, anchorStyle, positionedStyle } = useAnchor()
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)

  const show = () => {
    window.clearTimeout(timer.current)
    const delay = Date.now() - lastClosedAt < WARM_MS ? 0 : OPEN_DELAY_MS
    timer.current = window.setTimeout(() => tip.current?.showPopover(), delay)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    if (tip.current?.matches(':popover-open')) {
      tip.current.hidePopover()
      lastClosedAt = Date.now()
    }
  }

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('keydown', onEscape)
      window.clearTimeout(timer.current)
    }
  })

  const props = children.props
  return (
    <>
      {cloneElement(children, {
        // The tooltip replaces the browser's own title bubble.
        title: undefined,
        style: { ...props.style, ...anchorStyle },
        'aria-describedby': id,
        onPointerEnter: (event) => {
          props.onPointerEnter?.(event)
          show()
        },
        onPointerLeave: (event) => {
          props.onPointerLeave?.(event)
          hide()
        },
        onFocus: (event) => {
          props.onFocus?.(event)
          if ((event.target as HTMLElement).matches(':focus-visible')) show()
        },
        onBlur: (event) => {
          props.onBlur?.(event)
          hide()
        },
      })}
      <div
        ref={tip}
        id={id}
        popover="manual"
        role="tooltip"
        style={positionedStyle}
        className={`${side === 'top' ? '[position-area:block-start]' : '[position-area:block-end]'} pointer-events-none [inset:auto] [position-try-fallbacks:flip-block] my-1 max-w-64 bg-accent-fill px-2 py-1 text-accent-on-fill text-xs`}
      >
        {label}
      </div>
    </>
  )
}
