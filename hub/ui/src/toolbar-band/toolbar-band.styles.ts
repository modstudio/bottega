import { variant } from '../text/variant.ts'

export const toolbarBandStyles = variant({
  slots: {
    cell: 'relative flex h-10 min-w-0 basis-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap text-sm text-text-secondary transition-[flex-grow,opacity] duration-(--duration-base) hover:bg-control-hover hover:text-text-primary [&_svg]:size-4',
    slot1: 'flex divide-x divide-border-default border border-border-default bg-surface-page',
    slot2: 'flex h-full w-full items-center gap-1 pl-1 [&>*:first-child]:flex-1 [&_input]:border-0',
    slot3: 'flex h-full w-full items-center justify-center gap-1.5',
    slot4: 'absolute top-2 right-3 size-1.5 rounded-full bg-status-fill',
    slot5: 'sr-only',
  },
  variants: {
    search: { true: 'grow' },
    searching: {
      true: 'grow-0 border-x-0 opacity-0',
      false: 'grow opacity-100',
    },
  },
})
