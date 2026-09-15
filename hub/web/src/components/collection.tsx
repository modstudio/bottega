import type { ReactNode } from 'react'
import { EmptyState } from './design-system'
import { Input } from './input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'

export type CollectionColumn<Row> = {
  id: string
  label: ReactNode
  render: (row: Row) => ReactNode
  className?: string
}

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
  renderExpanded,
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
  renderExpanded?: (row: Row) => ReactNode
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
      <div className="border border-border [&>div]:max-h-[70vh]">
        <Table className="text-[12.5px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.id} className={column.className}>
                  {column.label}
                </TableHead>
              ))}
              {rowActions ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.flatMap((row) => {
              const key = getKey(row)
              const nested = renderExpanded?.(row)
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
                    <TableCell key={column.id} className={column.className}>
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
                nested ? (
                  <TableRow key={`${key}:children`}>
                    <TableCell colSpan={columns.length + (rowActions ? 1 : 0)}>{nested}</TableCell>
                  </TableRow>
                ) : null,
              ]
            })}
          </TableBody>
        </Table>
        {!rows.length ? <EmptyState title={empty.title} hint={empty.hint} /> : null}
      </div>
    </section>
  )
}
