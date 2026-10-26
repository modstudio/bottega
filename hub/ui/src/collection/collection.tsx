import { type ReactNode, useState } from 'react'
import { CardList, type CardListItem } from '../card-list/card-list'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { EmptyState } from '../empty-state/empty-state'
import { Input } from '../field/input'
import { PAGE_SIZES, type PageSize, Pagination } from '../pagination/pagination'
import { pageSlice } from '../state/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table/table'
import { TableCard } from '../table-card/table-card'
import { collectionStyles } from './collection.styles.ts'

/** A list the server pages: rows arrive as one page and `total` counts every match. */
export type ServerPaging = {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: PageSize) => void
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
  /**
   * Where the column goes when a phone shows each row as a card: the line that names the
   * record, beside it, the line of facts under it, or the details a reader opens. A column
   * without a role is left out on a phone.
   */
  phone?: 'title' | 'aside' | 'line' | 'more'
  /** How the value reads on a phone card, where the desk cell's truncation does not apply. */
  phoneRender?: (row: Row) => ReactNode
}

/** The card a phone shows for a row, from the roles its columns declare. */
function phoneCard<Row>(
  columns: CollectionColumn<Row>[],
  row: Row,
  key: string,
  children: CollectionChildRow[],
  selected: boolean,
  actions: ReactNode,
): CardListItem {
  const role = (name: NonNullable<CollectionColumn<Row>['phone']>) =>
    columns
      .filter((column) => column.phone === name)
      .map((column) => ({ ...column, render: column.phoneRender ?? column.render }))
  return {
    key,
    title: role('title').map((column) => <span key={column.id}>{column.render(row)}</span>),
    aside: role('aside').map((column) => <span key={column.id}>{column.render(row)}</span>),
    line: role('line').map((column) => column.render(row)),
    more: role('more').map((column) => ({ label: column.label, value: column.render(row) })),
    children: children.map((child) => ({
      key: child.key,
      line: columns
        .filter((column) => column.phone && column.phone !== 'more')
        .map((column) => child.cells[column.id] ?? null),
    })),
    selected,
    actions,
  }
}

type RowsProps<Row> = {
  columns: CollectionColumn<Row>[]
  /** The page of rows shown. */
  rows: Row[]
  /** Every row, for the empty state. */
  total: number
  getKey: (row: Row) => string | number
  onOpen: (row: Row) => void
  selectedKey?: string | number
  empty: { title: string; hint?: string }
  childRows?: (row: Row) => CollectionChildRow[]
}

/** On a phone, each row as the card its columns declare. */
function CollectionCards<Row>({
  title,
  columns,
  rows,
  total,
  getKey,
  onOpen,
  selectedKey,
  empty,
  childRows,
  rowActions,
}: RowsProps<Row> & { title: ReactNode; rowActions?: (row: Row) => ReactNode }) {
  if (!total) return <EmptyState title={empty.title} hint={empty.hint} />
  const keyed = new Map(rows.map((row) => [String(getKey(row)), row]))
  return (
    <CardList
      label={typeof title === 'string' ? title : 'Records'}
      items={rows.map((row) => {
        const key = String(getKey(row))
        return phoneCard(
          columns,
          row,
          key,
          childRows?.(row) ?? [],
          selectedKey !== undefined && String(selectedKey) === key,
          rowActions?.(row),
        )
      })}
      onOpen={(key) => {
        const row = keyed.get(key)
        if (row) onOpen(row)
      }}
    />
  )
}

function CollectionTable<Row>({
  columns,
  rows: visibleRows,
  total,
  getKey,
  onOpen,
  selectedKey,
  rowActions,
  empty,
  childRows,
}: RowsProps<Row> & { rowActions?: (row: Row) => ReactNode }) {
  const openFromKeyboard = (event: React.KeyboardEvent, row: Row) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(row)
    }
  }
  const span = columns.length + (rowActions ? 1 : 0)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead
              key={column.id}
              numeric={column.numeric}
              className={collectionStyles().column({
                grow: column.grow,
                lowPriority: column.priority === 'low',
              })}
            >
              {column.label}
            </TableHead>
          ))}
          {rowActions ? (
            <TableHead>
              <span className={collectionStyles().actionsLabel()}>Actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleRows.flatMap((row) => {
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
                  className={collectionStyles().column({
                    grow: column.grow,
                    lowPriority: column.priority === 'low',
                  })}
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
                    className={collectionStyles().column({
                      grow: column.grow,
                      lowPriority: column.priority === 'low',
                    })}
                  >
                    {child.cells[column.id] ?? null}
                  </TableCell>
                ))}
                {rowActions ? <TableCell /> : null}
              </TableRow>
            )),
          ]
        })}
        {!total ? (
          <tr>
            <td colSpan={span}>
              <EmptyState title={empty.title} hint={empty.hint} />
            </td>
          </tr>
        ) : null}
      </TableBody>
    </Table>
  )
}

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
  scope,
  summary,
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
  /** On a phone, what the page header scopes by, folded into the band. */
  scope?: ReactNode
  /** On a phone, the page's figures under the band. */
  summary?: ReactNode
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
  const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZES[1])
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
  const phone = useMediaQuery(PHONE_QUERY)
  const cards = phone && columns.some((column) => column.phone)
  return (
    <TableCard
      heading={
        <>
          <h2 className={collectionStyles().heading()}>{title}</h2>
          <span className={collectionStyles().count()}>{count.toLocaleString()}</span>
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
      scope={scope}
      summary={summary}
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
      {cards ? (
        <CollectionCards
          title={title}
          rowActions={rowActions}
          columns={columns}
          rows={visible.rows}
          total={rows.length}
          getKey={getKey}
          onOpen={onOpen}
          selectedKey={selectedKey}
          empty={empty}
          childRows={childRows}
        />
      ) : (
        <CollectionTable
          columns={columns}
          rows={visible.rows}
          total={rows.length}
          getKey={getKey}
          onOpen={onOpen}
          selectedKey={selectedKey}
          rowActions={rowActions}
          empty={empty}
          childRows={childRows}
        />
      )}
    </TableCard>
  )
}
