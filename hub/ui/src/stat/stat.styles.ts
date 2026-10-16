import { variant } from '../text/variant.ts'

export const statStyles = variant({
  slots: {
    figure:
      'truncate font-medium font-mono text-2xl tabular-nums tracking-tight @lg/stats:text-3xl',
    hint: 'text-sm text-text-muted',
    row: 'grid grid-cols-2 overflow-hidden border border-border-default',
    slot1: 'flex min-w-0 items-baseline gap-2',
    slot2: 'truncate text-sm text-text-secondary',
    slot3: 'm-0 flex items-center gap-1.5 border-0 p-0',
    slot4: 'sr-only',
    slot5: 'size-2 rounded-full bg-border-strong hover:bg-text-muted aria-pressed:bg-accent-fill',
    slot6:
      '-mr-px -mb-px flex min-w-0 flex-col gap-1 border-border-default border-r border-b p-4 @lg/stats:p-5',
    slot7: 'text-sm text-text-secondary',
    slot8: '@container/stats mb-6',
  },
  variants: {
    live: { true: 'text-status-text' },
    wrapHint: { false: 'truncate' },
    three: { true: '@3xl/stats:grid-cols-3' },
    four: { true: '@5xl/stats:grid-cols-4' },
  },
})
