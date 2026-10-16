import { Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, type ToggleEvent, useRef, useState } from 'react'
import { useAnchor } from '../dom/use-anchor'
import { useTypeahead } from '../dom/use-typeahead'
import { controlClasses } from '../field/control'
import { panelClasses, placementClasses } from '../popover/placement'
import { moveIndex, typeaheadIndex } from '../state/list-navigation'
import { classes } from '../text/classes'

export type SelectOption = { value: string; label: string; note?: string; disabled?: boolean }

/**
 * A single choice from a list, drawn entirely by us: a native select's popup is
 * the operating system's and no CSS reaches it. Keyboard behavior follows the
 * WAI-ARIA select-only combobox pattern.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  onOpenChange,
  size = 'md',
  className,
}: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  /** Names the control for assistive technology. */
  label: string
  onOpenChange?: (open: boolean) => void
  size?: 'sm' | 'md'
  /** Layout only: margin, width and placement. */
  className?: string
}) {
  const { id, anchorStyle, positionedStyle } = useAnchor()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const typeahead = useTypeahead()
  const disabled = options.map((option) => Boolean(option.disabled))
  const labels = options.map((option) => option.label)
  const selected = options.findIndex((option) => option.value === value)
  const current = options[selected]

  const optionAt = (index: number) =>
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  const activate = (index: number) => {
    setActive(index)
    optionAt(index)?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    list.current?.hidePopover()
    trigger.current?.focus()
  }

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open) return onListKeyDown(event)
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      list.current?.showPopover()
      return
    }
    const query = typeahead(event)
    if (query) {
      const index = typeaheadIndex(query, labels, selected, disabled)
      if (index !== selected) onChange(options[index]!.value)
    }
  }

  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return choose(active)
    }
    if (event.key === 'Tab') return list.current?.hidePopover()
    const moved = moveIndex(event.key, active, disabled, false)
    if (moved !== active) {
      event.preventDefault()
      return activate(moved)
    }
    const query = typeahead(event)
    if (query) activate(typeaheadIndex(query, labels, active, disabled))
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        popoverTarget={id}
        style={anchorStyle}
        onKeyDown={onTriggerKeyDown}
        className={classes(
          controlClasses,
          'inline-flex min-w-40 items-center justify-between gap-2 text-left',
          size === 'sm' ? 'h-control-sm px-2 text-sm' : 'h-control-md px-3',
          className,
        )}
      >
        <span className="truncate">{current?.label ?? 'Choose…'}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-icon-muted" />
      </button>
      <div
        ref={list}
        id={id}
        popover="auto"
        role="listbox"
        aria-label={label}
        style={positionedStyle}
        onToggle={(event: ToggleEvent<HTMLDivElement>) => {
          const next = event.newState === 'open'
          setOpen(next)
          onOpenChange?.(next)
          if (next) activate(selected >= 0 ? selected : moveIndex('Home', -1, disabled))
        }}
        className={classes(
          placementClasses('bottom', 'start'),
          panelClasses,
          'max-h-80 overflow-y-auto py-1',
        )}
      >
        {options.map((option, index) => (
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox; aria-activedescendant points here
          <div
            key={option.value}
            id={`${id}-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === selected}
            aria-disabled={option.disabled || undefined}
            onPointerMove={() => !option.disabled && setActive(index)}
            onPointerDown={(event) => event.preventDefault()}
            onPointerUp={() => choose(index)}
            className={classes(
              'flex min-h-control-md cursor-pointer items-center gap-2 px-3 py-1.5',
              index === active && 'bg-control-hover',
              option.disabled && 'cursor-not-allowed text-text-disabled',
            )}
          >
            <Check
              aria-hidden
              className={classes(
                'size-4 shrink-0',
                index === selected ? 'opacity-100' : 'opacity-0',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.note ? <span className="text-sm text-text-muted">{option.note}</span> : null}
          </div>
        ))}
      </div>
    </>
  )
}
