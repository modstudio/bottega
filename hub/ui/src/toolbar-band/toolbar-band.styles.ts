import { variant } from '../text/variant.ts'

export const toolbarBandStyles = variant({
  slots: {
    cell: 'relative flex h-10 min-w-0 basis-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap text-sm text-text-secondary transition-[flex-grow,opacity] duration-(--duration-base) hover:bg-control-hover hover:text-text-primary [&_svg]:size-4',
    root: 'flex divide-x divide-border-default border border-border-default bg-surface-page',
    search:
      'flex h-full w-full items-center gap-1 pl-1 [&>*:first-child]:flex-1 [&_input]:border-0',
    searchTrigger: 'flex h-full w-full items-center justify-center gap-1.5',
    activeIndicator: 'absolute top-2 right-3 size-1.5 rounded-full bg-status-fill',
    activeLabel: 'sr-only',
    sheetTabs: 'sticky top-0 z-10 -mt-1 bg-surface-overlay',
    sheetBody: 'flex flex-col gap-3 pt-4',
  },
  variants: {
    search: { true: { cell: 'grow' } },
    searching: {
      true: { cell: 'grow-0 border-x-0 opacity-0' },
      false: { cell: 'grow opacity-100' },
    },
  },
})
