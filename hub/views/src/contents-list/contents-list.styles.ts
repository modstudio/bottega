import { variant } from '@bottega/hub-ui/text/variant'

export const contentsListStyles = variant({
  slots: {
    label: 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase',
    list: 'mt-2.5 flex list-none flex-col gap-1.5 p-0',
    item: 'text-md text-text-muted hover:text-text-primary',
    count: 'ml-1 tabular-nums',
  },
  variants: {
    nested: { true: { list: 'mt-1.5 ml-4' } },
    current: { true: { item: 'font-medium text-text-primary' } },
  },
})
