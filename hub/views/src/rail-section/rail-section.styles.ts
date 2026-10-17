import { variant } from '@bottega/hub-ui/text/variant'

export const railSectionStyles = variant({
  slots: {
    root: 'border-border-default [&:not(:first-child)]:border-t',
    button:
      'font-mono text-text-muted text-xs tracking-[0.14em] uppercase flex w-full cursor-pointer items-center gap-2 py-3 text-left hover:text-text-primary',
    count: 'ml-auto tabular-nums tracking-normal',
    chevron: 'transition-transform duration-(--duration-fast)',
    body: 'pb-4',
  },
  variants: {
    countAbsent: { true: { chevron: 'ml-auto' } },
    open: { true: { chevron: 'rotate-180' } },
  },
})
