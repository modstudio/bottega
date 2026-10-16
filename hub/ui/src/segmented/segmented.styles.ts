import { variant } from '../text/variant.ts'

export const segmentedStyles = variant({
  slots: {
    root: 'm-0 inline-flex min-w-0 overflow-hidden border border-border-default p-0',
    slot1: 'sr-only',
  },
  variants: { size: { sm: 'h-control-sm', md: 'h-control-md' } },
  defaultVariants: { size: 'sm' },
})

export const segmentedOptionStyles = variant({
  base: 'inline-flex h-full items-center gap-1.5 border-border-default border-l bg-surface-sunken px-3 text-text-muted tabular-nums first-of-type:border-l-0 hover:text-text-primary [&_svg]:size-3.5 [&_svg]:text-border-strong [&_svg]:opacity-80 aria-pressed:bg-surface-page aria-pressed:font-medium aria-pressed:text-text-primary aria-pressed:[&_svg]:text-text-secondary',
  variants: { size: { sm: 'text-sm', md: '' } },
  defaultVariants: { size: 'sm' },
})
