import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useContext,
} from 'react'
import { cx } from '@/components/cx'

type TabsState = { value: string; onValueChange: (value: string) => void }

const TabsContext = createContext<TabsState | null>(null)

function useTabs() {
  const value = useContext(TabsContext)
  if (!value) throw new Error('Tabs parts must be used inside Tabs')
  return value
}

export function Tabs({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
}) {
  return <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>
}

export function TabsList({ className, onKeyDown, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { onValueChange } = useTabs()
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const tab = tabs[next]
    tab?.focus()
    const value = tab?.dataset.value
    if (value) onValueChange(value)
    onKeyDown?.(event)
  }
  return (
    <div
      role="tablist"
      className={cx(
        'inline-flex h-8 items-center justify-center rounded-none border border-border bg-background p-0 text-muted-foreground',
        className,
      )}
      onKeyDown={move}
      {...props}
    />
  )
}

export function TabsTrigger({
  value,
  className,
  ...props
}: { value: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <button
      type="button"
      role="tab"
      data-value={value}
      data-state={selected ? 'active' : 'inactive'}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cx(
        'inline-flex h-full items-center justify-center whitespace-nowrap rounded-none border-r border-border px-3 text-[12px] font-medium ring-offset-background last:border-r-0 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-muted data-[state=active]:text-foreground',
        className,
      )}
      onClick={() => tabs.onValueChange(value)}
      {...props}
    />
  )
}
