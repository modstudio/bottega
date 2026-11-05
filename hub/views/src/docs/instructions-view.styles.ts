import { variant } from '@bottega/hub-ui/text/variant'

export const instructionsViewStyles = variant({
  slots: {
    root: 'grid min-h-0 w-full grid-cols-1 gap-x-8 lg:grid-cols-[16rem_minmax(0,1fr)]',
    rail: 'flex flex-col gap-6 border-border-default border-b pb-5 lg:sticky lg:top-(--topbar-h) lg:self-start lg:border-b-0 lg:pt-6',
    group: 'flex flex-col gap-1',
    groupHeading: 'px-2 font-mono text-text-muted text-xs tracking-[0.14em] uppercase',
    groupHint: 'px-2 text-sm text-text-muted',
    row: 'flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-md',
    rowTitle: 'line-clamp-2 text-pretty',
    rowMeta: 'font-mono text-xs',
    empty: 'px-2 text-sm text-text-muted',
    reach: 'inline-flex items-center gap-1.5',
    reachAgent: 'text-text-primary',
    reachPath: 'font-mono text-xs',
    body: 'mt-6',
    editor: 'mt-6',
  },
  variants: {
    current: {
      true: { row: 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover' },
      false: { row: 'text-text-secondary hover:bg-control-hover' },
    },
  },
})
