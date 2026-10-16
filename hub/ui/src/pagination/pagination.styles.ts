import { variant } from '../text/variant.ts'

export const paginationStyles = variant({
  slots: {
    root: 'flex items-center justify-between gap-3 text-sm text-text-secondary',
    summary: 'tabular-nums',
    controls: 'flex items-center gap-2',
    pageSizeLabel: 'max-sm:hidden',
    pageSizeSelect: 'min-w-0',
    pageCount: 'min-w-16 text-center tabular-nums max-sm:hidden',
  },
})
