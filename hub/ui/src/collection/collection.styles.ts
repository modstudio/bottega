import { variant } from '../text/variant.ts'

export const collectionStyles = variant({
  slots: {
    column: '',
    heading: 'font-semibold text-md',
    count: 'text-text-muted tabular-nums',
    actionsLabel: 'sr-only',
  },
  variants: {
    grow: { true: { column: 'w-full max-w-0' } },
    lowPriority: { true: { column: 'hidden @5xl/rows:table-cell' } },
  },
})
