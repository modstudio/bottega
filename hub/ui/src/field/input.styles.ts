import { variant } from '../text/variant.ts'
import { controlClasses } from './control.ts'

export const inputStyles = variant({
  slots: {
    root: 'flex w-full flex-col gap-1.5',
    control: [controlClasses, 'w-full'],
  },
  variants: {
    size: {
      sm: { control: 'h-control-sm px-2 text-sm' },
      md: { control: 'h-control-md px-3' },
      title: { control: 'h-control-lg px-2 font-semibold text-xl' },
    },
  },
  defaultVariants: { size: 'md' },
})
