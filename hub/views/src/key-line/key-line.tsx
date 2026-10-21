import type { ReactNode } from 'react'
import { keyLineStyles } from './key-line.styles.ts'

export function KeyLine({
  items,
}: {
  items: { key: string; icon?: ReactNode; content: ReactNode }[]
}) {
  return (
    <div className={keyLineStyles().root()}>
      {items.map((item) => (
        <span key={item.key} className={keyLineStyles().item()}>
          {item.icon}
          {item.content}
        </span>
      ))}
    </div>
  )
}
