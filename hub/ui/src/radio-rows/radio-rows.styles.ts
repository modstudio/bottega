import { variant } from '../text/variant.ts'

export const radioRowsStyles = variant({
  slots: {
    option:
      'flex w-full cursor-pointer items-start gap-3 border p-3 text-left transition-colors hover:bg-control-hover has-focus-visible:outline-2 has-focus-visible:outline-accent-fill has-focus-visible:outline-offset-2',
    slot1: 'm-0 border-0 p-0',
    slot2: 'mb-2 font-medium text-sm',
    slot3: 'space-y-2',
    slot4: 'sr-only',
    slot5: 'min-w-0 flex-1',
    slot6: 'ml-2 whitespace-nowrap text-accent-text text-sm',
  },
  variants: {
    selected: {
      true: { option: 'border-accent-fill bg-surface-page text-text-primary' },
      false: { option: 'border-border-default bg-surface-sunken text-text-secondary' },
    },
  },
})

export const radioIndicatorStyles = variant({
  base: 'mt-0.5 size-4 shrink-0 rounded-full border-4',
  variants: {
    selected: {
      true: 'border-accent-fill bg-surface-page',
      false: 'border-border-strong bg-surface-page',
    },
  },
})
