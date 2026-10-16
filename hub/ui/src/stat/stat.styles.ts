import { variant } from '../text/variant.ts'

export const statStyles = variant({
  slots: {
    figure:
      'truncate font-medium font-mono text-2xl tabular-nums tracking-tight @lg/stats:text-3xl',
    hint: 'text-sm text-text-muted',
    row: 'grid grid-cols-2 overflow-hidden border border-border-default',
    figureHeading: 'flex min-w-0 items-baseline gap-2',
    figureLabel: 'truncate text-sm text-text-secondary',
    figurePicker: 'm-0 flex items-center gap-1.5 border-0 p-0',
    figurePickerLegend: 'sr-only',
    figurePickerOption:
      'size-2 rounded-full bg-border-strong hover:bg-text-muted aria-pressed:bg-accent-fill',
    card: '-mr-px -mb-px flex min-w-0 flex-col gap-1 border-border-default border-r border-b p-4 @lg/stats:p-5',
    cardLabel: 'text-sm text-text-secondary',
    group: '@container/stats mb-6',
  },
  variants: {
    live: { true: { figure: 'text-status-text' } },
    wrapHint: { false: { hint: 'truncate' } },
    three: { true: { row: '@3xl/stats:grid-cols-3' } },
    four: { true: { row: '@5xl/stats:grid-cols-4' } },
  },
})
