import { type KeyboardEvent, useId } from 'react'
import { classes } from '../text/classes'

type TabItem = { value: string; label: string; count?: number }

/**
 * Tabs over panels of one record, following the WAI-ARIA tabs pattern: arrow
 * keys move and select, Home and End jump, and only the selected tab is in the
 * tab order. Render the active panel with `tabPanelProps`. A strip that filters
 * a list is not tabs; use Segmented.
 */
export function Tabs({
  label,
  value,
  onChange,
  items,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  items: readonly TabItem[]
}) {
  const id = useId()
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === value)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    const target = items[next]!
    onChange(target.value)
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(target.value)}"]`)
      ?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className="flex min-w-0 gap-4 overflow-x-auto border-border-default border-b"
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${id}-tab-${item.value}`}
            aria-controls={`${id}-panel`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-value={item.value}
            onClick={() => onChange(item.value)}
            className={classes(
              '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-text-secondary hover:text-text-primary',
              selected ? 'border-accent-fill font-medium text-text-primary' : 'border-transparent',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="text-sm text-text-muted tabular-nums">{item.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
