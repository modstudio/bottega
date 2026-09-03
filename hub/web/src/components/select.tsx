import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cx } from '@/components/cx'

export type SelectOption = { value: string; label: string; note?: string }

/**
 * A listbox, because a native <select> draws its popup with the OS and no CSS
 * reaches inside it: the closed control matched this design and the open one
 * never could. Native gave keyboard, focus and type-ahead for free, so all of
 * that is written out here rather than lost.
 */
export function Select({
  value, options, onChange, label, onOpenChange,
}: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  label: string
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const restore = useRef(false)
  const id = useId()

  const selected = options.findIndex((option) => option.value === value)
  const current = options[selected >= 0 ? selected : 0]

  // Paired in an effect so the caller's open-count cannot drift: unmounting
  // while open still reports the close.
  useEffect(() => {
    if (!open) return
    onOpenChange?.(true)
    return () => onOpenChange?.(false)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    setActive(selected >= 0 ? selected : 0)
    list.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  // Focus has to be restored AFTER the list unmounts: focusing the trigger while
  // the list still holds focus is undone when the browser drops the removed
  // element's focus to <body>, which strands a keyboard user at the top of the page.
  useLayoutEffect(() => {
    if (open || !restore.current) return
    restore.current = false
    trigger.current?.focus()
  }, [open])

  const close = (focusTrigger = true) => {
    restore.current = focusTrigger
    setOpen(false)
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    close()
  }

  /** Jump to the next option starting with what was typed, as a native select does. */
  const typeAhead = (key: string) => {
    const now = Date.now()
    typed.current = { text: now - typed.current.at > 700 ? key : typed.current.text + key, at: now }
    const query = typed.current.text.toLowerCase()
    const from = query.length === 1 ? active + 1 : active
    for (let step = 0; step < options.length; step += 1) {
      const index = (from + step) % options.length
      if (options[index]!.label.toLowerCase().startsWith(query)) return setActive(index)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(options.length - 1, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: () => close(),
      Tab: () => close(false),
    }
    const handler = keys[event.key]
    if (handler) {
      if (event.key !== 'Tab') event.preventDefault()
      handler()
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      typeAhead(event.key)
    }
  }

  return (
    <div ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-9 items-center border border-input bg-background py-0 pl-3 pr-8 text-[13px] font-medium hover:bg-accent hover:text-accent-foreground"
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="whitespace-nowrap">{current?.label ?? label}</span>
        {current?.note ? <span className="ml-1.5 text-muted-foreground">({current.note})</span> : null}
      </button>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2" />
      {open ? (
        <ul
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          className="absolute left-0 top-full z-40 mt-px max-h-72 min-w-full overflow-y-auto border border-border bg-background py-1 shadow-md outline-none"
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selected}
              className={cx(
                'flex cursor-default items-center gap-2 whitespace-nowrap py-1 pl-2 pr-4 text-[13px]',
                index === active && 'bg-muted',
              )}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <Check className={cx('size-3.5 shrink-0', index === selected ? 'opacity-100' : 'opacity-0')} />
              <span>{option.label}</span>
              {option.note ? <span className="text-muted-foreground">({option.note})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
