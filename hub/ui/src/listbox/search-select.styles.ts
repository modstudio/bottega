import { variant } from '../text/variant.ts'

export const searchSelectStyles = variant({
  slots: {
    slot1: 'grid w-72 max-w-full gap-2',
    slot2: '-mx-1 max-h-72 overflow-y-auto',
    slot3:
      'block w-full cursor-pointer truncate rounded-sm px-2 py-1.5 text-left text-md text-text-secondary aria-selected:font-medium aria-selected:text-text-primary data-active:bg-control-hover',
    slot4: 'm-0 px-2 py-1.5 text-md text-text-muted',
    slot5: 'm-0 px-2 py-1.5 text-sm text-text-muted',
  },
})
