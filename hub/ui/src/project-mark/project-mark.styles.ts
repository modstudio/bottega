import { variant } from '../text/variant.ts'

export const projectMarkStyles = variant({
  slots: {
    root: 'inline-flex items-center gap-2 whitespace-nowrap font-medium',
    mark: 'h-3.5 w-[3px] shrink-0 bg-project',
  },
})
