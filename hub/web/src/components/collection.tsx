import { type ReactNode, useState } from 'react'
import { Input } from '@/ui/field/input'
import { PAGE_SIZES, Pagination } from '@/ui/pagination/pagination'
import { pageSlice } from '@/ui/state/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'
import { TableCard } from '@/ui/table-card/table-card'
import { EmptyState } from './design-system'

/** A list the server pages: rows arrive as one page and `total` counts every match. */
export type ServerPaging = {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

/** A row nested under a record, filling the same columns so its values line up. */
export type CollectionChildRow = { key: string; cells: Partial<Record<string, ReactNode>> }

export type CollectionColumn<Row> = {
  id: string
  label: ReactNode
  render: (row: Row) => ReactNode
  /** Right-aligned tabular figures. */
  numeric?: boolean
  /** Takes the width the other columns leave; its content should truncate. */
  grow?: boolean
  /** Dropped when the table's own container is narrow, before anything else is squeezed. */
  priority?: 'low'
}

const columnLayout = <Row,>(column: CollectionColumn<Row>) =>
  [
    column.grow ? 'w-full max-w-0' : null,
    column.priority === 'low' ? 'hidden @5xl/rows:table-cell' : null,
  ]
    .filter(Boolean)
    .join(' ')

/**
 * A table of records on a TableCard: one page at a time, each row opening its
 * record, with optional nested rows that share the record's columns.
 */
export function Collection<Row>({
  title,
  count,
  search,
  filters,
  filtersActive,
  view,
  actions,
  pageActions,
  panel,
  selectedKey,
  paging,
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
  filtersActive?: number
  view?: ReactNode
  actions?: ReactNode
  pageActions?: ReactNode
  panel?: ReactNode
  /** The row whose record is open in the panel. */
  selectedKey?: string | number
  /** Set when the server pages the rows; otherwise the table pages them itself. */
  paging?: ServerPaging
  columns: CollectionColumn<Row>[]
  rows: Row[]
  getKey: (row: Row) => string | number
  onOpen: (row: Row) => void
  rowActions?: (row: Row) => ReactNode
  empty: { title: string; hint?: string }
  childRows?: (row: Row) => CollectionChildRow[]
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[1])
  const local = pageSlice(rows, page, pageSize)
  const visible = paging ? { ...local, rows, page: paging.page } : local
  const pager: ServerPaging = paging ?? {
    page: local.page,
    pageSize,
    total: rows.length,
    onPageChange: setPage,
    onPageSizeChange: (size) => {
      setPageSize(size)
      setPage(1)
    },
  }
  const openFromKeyboard = (event: React.KeyboardEvent, row: Row) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(row)
    }
  }
  const span = columns.length + (rowActions ? 1 : 0)
  return (
    <TableCard
      heading={
        <>
          <h2 className="font-semibold text-md">{title}</h2>
          <span className="text-text-muted tabular-nums">{count.toLocaleString()}</span>
        </>
      }
      search={
        search ? (
          <Input
            type="search"
            size="sm"
            aria-label={search.placeholder ?? 'Search'}
            value={search.query}
            onChange={(event) => search.onQueryChange(event.target.value)}
            placeholder={search.placeholder ?? 'Search'}
          />
        ) : undefined
      }
      filters={filters}
      filtersActive={filtersActive}
      view={view}
      actions={actions}
      pageActions={pageActions}
      panel={panel}
      footer={
        pager.total > PAGE_SIZES[0] ? (
          <Pagination
            page={pager.page}
            pageSize={pager.pageSize}
            total={pager.total}
            onPageChange={pager.onPageChange}
            onPageSizeChange={pager.onPageSizeChange}
          />
        ) : undefined
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.id} numeric={column.numeric} className={columnLayout(column)}>
                {column.label}
              </TableHead>
            ))}
            {rowActions ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.rows.flatMap((row) => {
            const key = getKey(row)
            const children = childRows?.(row) ?? []
            return [
              <TableRow
                key={key}
                interactive
                selected={selectedKey !== undefined && String(selectedKey) === String(key)}
                data-record-key={String(key)}
                tabIndex={0}
                onClick={() => onOpen(row)}
                onKeyDown={(event) => openFromKeyboard(event, row)}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    numeric={column.numeric}
                    nowrap={!column.grow}
                    className={columnLayout(column)}
                  >
                    {column.render(row)}
                  </TableCell>
                ))}
                {rowActions ? (
                  <TableCell
                    nowrap
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {rowActions(row)}
                  </TableCell>
                ) : null}
              </TableRow>,
              ...children.map((child) => (
                <TableRow key={`${key}:${child.key}`} nested>
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      numeric={column.numeric}
                      nowrap={!column.grow}
                      className={columnLayout(column)}
                    >
                      {child.cells[column.id] ?? null}
                    </TableCell>
                  ))}
                  {rowActions ? <TableCell /> : null}
                </TableRow>
              )),
            ]
          })}
          {!rows.length ? (
            <tr>
              <td colSpan={span}>
                <EmptyState title={empty.title} hint={empty.hint} />
              </td>
            </tr>
          ) : null}
        </TableBody>
      </Table>
    </TableCard>
  )
}
