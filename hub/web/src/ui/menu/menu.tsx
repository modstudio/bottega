import type { LucideIcon } from 'lucide-react'
import {
  cloneElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type ToggleEvent,
  useRef,
  useState,
} from 'react'
import { useAnchor } from '../dom/use-anchor'
import { useTypeahead } from '../dom/use-typeahead'
import { type Align, panelClasses, placementClasses, type Side } from '../popover/placement'
import { moveIndex, typeaheadIndex } from '../state/list-navigation'
import { classes } from '../text/classes'

export type MenuItem = {
  label: string
  onSelect: () => void
  icon?: LucideIcon
  disabled?: boolean
  /** A destructive action, drawn in the error tone. */
  danger?: boolean
}

type TriggerProps = {
  popoverTarget?: string
  style?: React.CSSProperties
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'menu'
  'aria-controls'?: string
  onKeyDown?: (event: KeyboardEvent) => void
}

/** A list of actions opened from a trigger, following the WAI-ARIA menu button pattern. */
export function Menu({
  trigger,
  items,
  side = 'bottom',
  align = 'start',
  header,
}: {
  trigger: ReactElement<TriggerProps>
  items: readonly MenuItem[]
  /** Context above the items, such as who is signed in. Not interactive. */
  header?: ReactNode
  side?: Side
  align?: Align
}) {
  const { id, anchorStyle, positionedStyle } = useAnchor()
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const typeahead = useTypeahead()
  const disabled = items.map((item) => Boolean(item.disabled))
  const labels = items.map((item) => item.label)
  const focusStart = useRef<'first' | 'last'>('first')

  const buttons = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []),
  ]
  const focusAt = (index: number) => buttons()[index]?.focus()
  const current = () => buttons().indexOf(document.activeElement as HTMLButtonElement)
  const close = () => {
    menu.current?.hidePopover()
    document.getElementById(`${id}-trigger`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') return menu.current?.hidePopover()
    const moved = moveIndex(event.key, current(), disabled)
    if (moved !== current()) {
      event.preventDefault()
      return focusAt(moved)
    }
    const query = typeahead(event)
    if (query) focusAt(typeaheadIndex(query, labels, current(), disabled))
  }

  return (
    <>
      {cloneElement(trigger, {
        id: `${id}-trigger`,
        popoverTarget: id,
        style: { ...trigger.props.style, ...anchorStyle },
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-controls': id,
        onKeyDown: (event: KeyboardEvent) => {
          trigger.props.onKeyDown?.(event)
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          focusStart.current = event.key === 'ArrowUp' ? 'last' : 'first'
          menu.current?.showPopover()
        },
      } as TriggerProps & { id: string })}
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-labelledby={`${id}-trigger`}
        style={positionedStyle}
        onKeyDown={onKeyDown}
        onToggle={(event: ToggleEvent<HTMLDivElement>) => {
          const next = event.newState === 'open'
          setOpen(next)
          if (!next) return
          focusAt(moveIndex(focusStart.current === 'last' ? 'End' : 'Home', -1, disabled))
          focusStart.current = 'first'
        }}
        className={classes(placementClasses(side, align), panelClasses, 'min-w-44 py-1')}
      >
        {header ? (
          <div className="mb-1 border-border-subtle border-b px-3 pt-1.5 pb-2">{header}</div>
        ) : null}
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              data-tone={item.danger ? 'error' : undefined}
              onClick={() => {
                close()
                item.onSelect()
              }}
              className={classes(
                'flex h-control-md w-full items-center gap-2 px-3 text-left outline-none hover:bg-control-hover focus-visible:bg-control-hover disabled:text-text-disabled [&_svg]:size-4',
                item.danger && 'text-status-text',
              )}
            >
              {Icon ? <Icon aria-hidden /> : null}
              {item.label}
            </button>
          )
        })}
      </div>
    </>
  )
}
