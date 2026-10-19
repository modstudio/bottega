import { ChevronDown, ChevronUp } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cardListStyles } from './card-list.styles.ts'

/** One record as a phone card: the line that names it, a line of facts, and details on demand. */
export type CardListItem = {
  key: string
  title: ReactNode
  aside?: ReactNode
  line?: ReactNode[]
  more?: { label: ReactNode; value: ReactNode }[]
  /** Nested records shown inside the card, each as one line of facts. */
  children?: { key: string; line: ReactNode[] }[]
  selected?: boolean
  /** Controls acting on the record itself, apart from opening it. */
  actions?: ReactNode
}

function Line({ parts }: { parts: ReactNode[] }) {
  // A table's empty-cell dash says nothing on a card, so it is left out like an empty cell.
  const present = parts.filter(
    (part) => part !== null && part !== undefined && part !== '' && part !== '-' && part !== '—',
  )
  if (!present.length) return null
  return (
    <div className={cardListStyles().line()}>
      {present.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional cells of one row.
        <span key={index} className={cardListStyles().part()}>
          {part}
        </span>
      ))}
    </div>
  )
}

function Card({ item, onOpen }: { item: CardListItem; onOpen: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={cardListStyles({ selected: item.selected }).card()}>
      <button type="button" className={cardListStyles().open()} onClick={() => onOpen(item.key)}>
        <div className={cardListStyles().head()}>
          <div className={cardListStyles().title()}>{item.title}</div>
          {item.aside ? <div className={cardListStyles().aside()}>{item.aside}</div> : null}
        </div>
        {item.line ? <Line parts={item.line} /> : null}
        {item.children?.map((child) => (
          <div key={child.key} className={cardListStyles().child()}>
            <Line parts={child.line} />
          </div>
        ))}
      </button>
      {item.actions ? <div className={cardListStyles().actions()}>{item.actions}</div> : null}
      {item.more?.length ? (
        <>
          {open ? (
            <dl className={cardListStyles().more()}>
              {item.more.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: details are positional fields of one row.
                <div key={index} className={cardListStyles().field()}>
                  <dt className={cardListStyles().fieldLabel()}>{entry.label}</dt>
                  <dd className={cardListStyles().fieldValue()}>{entry.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            className={cardListStyles().toggle()}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {open ? 'Less' : 'More'}
          </button>
        </>
      ) : null}
    </li>
  )
}

/** Records as cards on a phone, where a table's columns cannot fit side by side. */
export function CardList({
  label,
  items,
  onOpen,
}: {
  label: string
  items: CardListItem[]
  onOpen: (key: string) => void
}) {
  return (
    <ul aria-label={label} className={cardListStyles().root()}>
      {items.map((item) => (
        <Card key={item.key} item={item} onOpen={onOpen} />
      ))}
    </ul>
  )
}
