import { variant } from '../text/variant.ts'

export const avatarStyles = variant({
  base: 'inline-flex size-6 shrink-0 select-none items-center justify-center border border-border-subtle bg-surface-sunken font-medium text-text-secondary text-xs uppercase',
  variants: {
    known: { true: '', false: 'border-dashed text-text-muted' },
  },
  defaultVariants: { known: true },
})
