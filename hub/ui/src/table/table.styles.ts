import { variant } from '../text/variant.ts'

export const tableStyles = variant({
  slots: {
    table: 'w-full border-collapse text-base',
    slot1: 'sticky top-0 z-(--z-sticky) bg-surface-page',
    slot2: '[&>tr:last-child]:border-b-0',
  },
  variants: {
    nested: { true: 'bg-surface-raised text-text-secondary' },
    interactive: {
      true: 'cursor-pointer outline-none hover:bg-control-hover focus-visible:bg-control-hover focus-visible:shadow-[inset_2px_0_0_var(--focus-color)]',
    },
    selected: { true: 'bg-surface-sunken shadow-[inset_2px_0_0_var(--accent-fill)]' },
    numeric: { true: 'whitespace-nowrap text-right tabular-nums' },
    nowrap: { true: 'whitespace-nowrap' },
    muted: { true: 'text-text-muted' },
  },
})

export const tableRowStyles = variant({
  base: 'h-row border-border-subtle border-b',
  variants: tableStyles.variants,
})

export const tableHeadStyles = variant({
  base: 'h-10 border-border-default border-b px-3 text-left align-middle font-normal text-sm text-text-muted',
  variants: {
    numeric: { true: 'whitespace-nowrap text-right tabular-nums' },
    nowrap: { true: 'whitespace-nowrap' },
    muted: { true: 'text-text-muted' },
  },
})

export const tableCellStyles = variant({
  base: 'px-3 py-2 align-middle',
  variants: {
    numeric: { true: 'whitespace-nowrap text-right tabular-nums' },
    nowrap: { true: 'whitespace-nowrap' },
    muted: { true: 'text-text-muted' },
  },
})
