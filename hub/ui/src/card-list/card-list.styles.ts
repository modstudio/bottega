import { variant } from '../text/variant.ts'

export const cardListStyles = variant({
  slots: {
    root: 'm-0 flex list-none flex-col divide-y divide-border-default p-0',
    card: 'bg-surface-page',
    open: 'flex w-full cursor-pointer flex-col gap-1.5 px-4 py-3.5 text-left hover:bg-control-hover',
    head: 'flex min-w-0 items-start justify-between gap-3',
    title: 'flex min-w-0 flex-wrap items-baseline gap-x-2 font-medium text-text-primary',
    aside: 'shrink-0',
    line: 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted',
    part: "inline-flex items-center gap-1.5 [&:not(:first-child)]:before:text-text-muted [&:not(:first-child)]:before:content-['·']",
    child: 'border-border-default border-l-2 pl-3',
    actions: 'flex min-h-control-lg items-center gap-2 px-4 text-sm',
    more: 'm-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 pb-2 text-sm',
    field: 'contents',
    fieldLabel: 'text-text-muted',
    fieldValue: 'm-0 min-w-0',
    toggle:
      'flex min-h-control-lg w-full cursor-pointer items-center gap-1 px-4 text-sm text-text-muted hover:text-text-primary [&_svg]:size-4',
  },
  variants: {
    selected: { true: { card: 'border-accent-fill border-l-2' } },
  },
})
