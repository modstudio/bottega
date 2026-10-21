import { type KeyboardEvent, useId } from 'react'
import { tabStyles, tabsStyles } from './tabs.styles.ts'

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
  id: givenId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  items: readonly TabItem[]
  /** Names the tabs so the owner of the panel can label it: `${id}-panel`, `${id}-tab-${value}`. */
  id?: string
}) {
  const ownId = useId()
  const id = givenId ?? ownId
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
    <div role="tablist" aria-label={label} onKeyDown={move} className={tabsStyles().list()}>
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
            className={tabStyles({ selected })}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={tabsStyles().count()}>{item.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
