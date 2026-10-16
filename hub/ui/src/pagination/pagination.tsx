import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '../button/button'
import { Select } from '../listbox/select'
import { paginationStyles } from './pagination.styles.ts'

export const PAGE_SIZES = [25, 50, 100] as const
export type PageSize = (typeof PAGE_SIZES)[number]

/**
 * Moves through a long list a page at a time. `total` is known for a
 * client-paged list; a cursor-paged list passes only `hasNext`.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hasNext,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number
  pageSize: number
  total?: number
  hasNext?: boolean
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: PageSize) => void
  className?: string
}) {
  const pageCount = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = total === undefined ? page * pageSize : Math.min(page * pageSize, total)
  const canNext = pageCount === undefined ? Boolean(hasNext) : page < pageCount
  return (
    <nav aria-label="Pagination" className={paginationStyles().root({ class: className })}>
      <span className={paginationStyles().slot1()}>
        {total === undefined
          ? `Page ${page}`
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className={paginationStyles().slot2()}>
        {onPageSizeChange ? (
          <span className={paginationStyles().slot3()}>
            <Select
              label="Rows per page"
              size="sm"
              className={paginationStyles().slot4()}
              value={String(pageSize)}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} rows` }))}
              onChange={(value) => onPageSizeChange(Number(value) as PageSize)}
            />
          </span>
        ) : null}
        <IconButton
          size="sm"
          variant="secondary"
          label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </IconButton>
        {pageCount !== undefined ? (
          <span className={paginationStyles().slot5()}>
            {page} / {pageCount}
          </span>
        ) : null}
        <IconButton
          size="sm"
          variant="secondary"
          label="Next page"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </IconButton>
      </div>
    </nav>
  )
}
