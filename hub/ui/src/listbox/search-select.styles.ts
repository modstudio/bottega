import { variant } from '../text/variant.ts'

export const searchSelectStyles = variant({
  slots: {
    root: 'grid w-72 max-w-full gap-2',
    options: '-mx-1 max-h-72 overflow-y-auto',
    option:
      'block w-full cursor-pointer truncate rounded-sm px-2 py-1.5 text-left text-md text-text-secondary aria-selected:font-medium aria-selected:text-text-primary data-active:bg-control-hover',
    emptyMessage: 'm-0 px-2 py-1.5 text-md text-text-muted',
    moreMessage: 'm-0 px-2 py-1.5 text-sm text-text-muted',
  },
})
