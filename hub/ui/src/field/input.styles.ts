import { variant } from '../text/variant.ts'
import { controlClasses } from './control.ts'

export const inputStyles = variant({
  base: [controlClasses, 'w-full'],
  variants: {
    size: {
      sm: 'h-control-sm px-2 text-sm',
      md: 'h-control-md px-3',
      title: 'h-control-lg px-2 font-semibold text-xl',
    },
  },
  defaultVariants: { size: 'md' },
})
