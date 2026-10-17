import type { ReactNode } from 'react'
import { contentsListStyles } from './contents-list.styles.ts'

export type ContentsItem = {
  id: string
  label: ReactNode
  href?: string
  onSelect?: () => void
  count?: number
  children?: ContentsItem[]
  current?: boolean
}

function Items({ items, nested = false }: { items: ContentsItem[]; nested?: boolean }) {
  return (
    <ul className={contentsListStyles({ nested }).list()}>
      {items.map((item) => {
        const content = (
          <>
            {item.label}
            {item.count !== undefined ? (
              <span className={contentsListStyles().count()}>{item.count}</span>
            ) : null}
          </>
        )
        return (
          <li key={item.id}>
            {item.href ? (
              <a
                href={item.href}
                onClick={item.onSelect}
                className={contentsListStyles({ current: item.current }).item()}
              >
                {content}
              </a>
            ) : (
              <button
                type="button"
                onClick={item.onSelect}
                className={contentsListStyles({ current: item.current }).item()}
              >
                {content}
              </button>
            )}
            {item.children?.length ? <Items items={item.children} nested /> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function ContentsList({
  label = 'On this page',
  items,
}: {
  label?: string
  items: ContentsItem[]
}) {
  if (!items.length) return null
  return (
    <section>
      <span className={contentsListStyles().label()}>{label}</span>
      <Items items={items} />
    </section>
  )
}
