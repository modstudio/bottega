import { type ComponentProps, useRef, useState } from 'react'
import { Input } from '../field/input'
import { Popover } from '../popover/popover'
import { moveIndex } from '../state/list-navigation'
import { searchSelectStyles } from './search-select.styles.ts'

/** How many matches the list shows before asking for a narrower search. */
const SEARCH_LIMIT = 50

type Option = { value: string; label: string }

/** The options whose label contains the query, up to `limit`, and how many more matched. */
export function searchMatches(
  options: readonly Option[],
  query: string,
  limit: number,
): { shown: Option[]; more: number; none: boolean } {
  const needle = query.trim().toLowerCase()
  const matches = options.filter((option) => option.label.toLowerCase().includes(needle))
  return {
    shown: matches.slice(0, limit),
    more: Math.max(0, matches.length - limit),
    none: matches.length === 0,
  }
}

/**
 * A single choice from a long list: the trigger opens a panel with a search field and a scrolling
 * list of one-line matches. Arrow keys move through the matches, Enter chooses, Escape closes.
 */
export function SearchSelect({
  label,
  value,
  options,
  onChange,
  trigger,
}: {
  /** Names the panel and its list for assistive technology. */
  label: string
  value: string
  options: readonly Option[]
  onChange: (value: string) => void
  /** The control that opens the panel; the caller owns how it looks. */
  trigger: ComponentProps<typeof Popover>['trigger']
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const { shown, more, none } = searchMatches(options, query, SEARCH_LIMIT)
  const choose = (option: Option | undefined) => {
    if (!option) return
    panel.current?.hidePopover()
    if (option.value !== value) onChange(option.value)
  }
  return (
    <Popover
      ref={panel}
      label={label}
      onOpenChange={(open) => {
        setQuery('')
        setActive(0)
        if (open) input.current?.focus()
      }}
      trigger={trigger}
    >
      <div className={searchSelectStyles().root()}>
        <Input
          ref={input}
          size="sm"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(
                moveIndex(
                  event.key,
                  active,
                  shown.map(() => false),
                  false,
                ),
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(shown[active])
            }
          }}
        />
        <div role="listbox" aria-label={label} className={searchSelectStyles().options()}>
          {shown.map((option, index) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={option.value === value}
              data-active={index === active ? '' : undefined}
              title={option.label}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
              className={searchSelectStyles().option()}
            >
              {option.label}
            </button>
          ))}
          {none ? (
            <p className={searchSelectStyles().emptyMessage()}>No match</p>
          ) : more > 0 ? (
            <p className={searchSelectStyles().moreMessage()}>{more} more; narrow the search</p>
          ) : null}
        </div>
      </div>
    </Popover>
  )
}
