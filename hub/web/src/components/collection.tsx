import type { ReactNode } from 'react'
import { Input } from '@/ui/field/input'
import { EmptyState } from './design-system'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'

/** A row nested under a record, filling the same columns so its values line up. */
export type CollectionChildRow = { key: string; cells: Partial<Record<string, ReactNode>> }

export type CollectionColumn<Row> = {
  id: string
  label: ReactNode
  render: (row: Row) => ReactNode
  className?: string
  /** Dropped when the table's own container is narrow, before anything else is squeezed. */
  priority?: 'low'
}

const LOW_PRIORITY = 'hidden @5xl/table:table-cell'

const columnClass = <Row,>(column: CollectionColumn<Row>) =>
  [column.className, column.priority === 'low' ? LOW_PRIORITY : null].filter(Boolean).join(' ')

export function Collection<Row>({
  title,
  count,
  search,
  filters,
  columns,
  rows,
  getKey,
  onOpen,
  rowActions,
  empty,
  childRows,
}: {
  title: ReactNode
  count: number
  search?: { query: string; onQueryChange: (query: string) => void; placeholder?: string }
  filters?: ReactNode
  columns: CollectionColumn<Row>[]
  rows: Row[]
  getKey: (row: Row) => string | number
  onOpen: (row: Row) => void
  rowActions?: (row: Row) => ReactNode
  empty: { title: string; hint?: string }
  childRows?: (row: Row) => CollectionChildRow[]
}) {
  const openFromKeyboard = (event: React.KeyboardEvent, row: Row) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(row)
    }
  }
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-sans text-[15px] font-semibold">{title}</h2>
        <span className="text-muted-foreground">{count}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {search ? (
            <Input
              type="search"
              className="h-8 w-56"
              value={search.query}
              onChange={(event) => search.onQueryChange(event.target.value)}
              placeholder={search.placeholder ?? 'Search'}
            />
          ) : null}
          {filters}
        </div>
      </div>
      <div className="@container/table border border-border [&>div]:max-h-[70vh]">
        <Table className="text-[12.5px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.id} className={columnClass(column)}>
                  {column.label}
                </TableHead>
              ))}
              {rowActions ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.flatMap((row) => {
              const key = getKey(row)
              const children = childRows?.(row) ?? []
              return [
                <TableRow
                  key={key}
                  data-record-key={String(key)}
                  tabIndex={0}
                  className="data-table-link cursor-pointer"
                  onClick={() => onOpen(row)}
                  onKeyDown={(event) => openFromKeyboard(event, row)}
                >
                  {columns.map((column) => (
                    <TableCell key={column.id} className={columnClass(column)}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                  {rowActions ? (
                    <TableCell
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {rowActions(row)}
                    </TableCell>
                  ) : null}
                </TableRow>,
                ...children.map((child) => (
                  <TableRow
                    key={`${key}:${child.key}`}
                    className="bg-surface-sunken text-text-secondary"
                  >
                    {columns.map((column) => (
                      <TableCell key={column.id} className={columnClass(column)}>
                        {child.cells[column.id] ?? null}
                      </TableCell>
                    ))}
                    {rowActions ? <TableCell /> : null}
                  </TableRow>
                )),
              ]
            })}
          </TableBody>
        </Table>
        {!rows.length ? <EmptyState title={empty.title} hint={empty.hint} /> : null}
      </div>
    </section>
  )
}
