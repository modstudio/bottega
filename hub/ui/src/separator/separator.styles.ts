import { variant } from '../text/variant.ts'

export const separatorStyles = variant({
  base: 'm-0 shrink-0 border-0 bg-border-default',
  variants: {
    orientation: {
      horizontal: 'h-px w-full',
      vertical: 'h-auto w-px self-stretch',
    },
  },
  defaultVariants: { orientation: 'horizontal' },
})
