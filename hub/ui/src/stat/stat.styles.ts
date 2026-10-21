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
    cardLabel: 'flex items-center gap-1 text-sm text-text-secondary',
    about: 'w-72 whitespace-normal text-sm text-text-secondary',
    aboutTrigger: '-my-1',
    group: '@container/stats mb-6',
    band: 'mb-4 flex items-stretch border border-border-default',
    bandFigures:
      'flex min-w-0 flex-1 divide-x divide-border-default overflow-x-auto [scrollbar-width:none]',
    bandToggle:
      'flex w-11 shrink-0 items-center justify-center border-border-default border-l text-text-secondary hover:bg-control-hover hover:text-text-primary [&_svg]:size-4',
    chip: 'flex min-h-control-lg shrink-0 items-center gap-1.5 whitespace-nowrap px-3.5',
    chipFigure: 'font-medium font-mono text-sm tabular-nums',
    chipLabel: 'text-text-muted text-xs',
    less: 'mt-1 flex min-h-control-lg items-center gap-1 text-sm text-text-muted hover:text-text-primary [&_svg]:size-4',
  },
  variants: {
    live: { true: { figure: 'text-status-text', chipFigure: 'text-status-text' } },
    phone: { true: { row: 'grid-cols-1' } },
    wrapHint: { false: { hint: 'truncate' } },
    // The (i) carries its own padding, so the chip's edge beside it closes in.
    about: { true: { chip: 'pr-1.5' } },
    three: { true: { row: '@3xl/stats:grid-cols-3' } },
    four: { true: { row: '@5xl/stats:grid-cols-4' } },
  },
})
