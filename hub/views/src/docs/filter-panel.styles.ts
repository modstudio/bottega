import { variant } from '@bottega/hub-ui/text/variant'

export const filterPanelStyles = variant({
  slots: {
    legend: 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase mb-1.5 px-0',
    audienceOption: 'flex cursor-pointer items-center gap-2 py-1 text-md text-text-secondary',
    input: 'sr-only',
    optionCount: 'ml-auto font-mono text-text-muted text-xs',
    panel: 'w-[min(17.5rem,calc(100vw-2.5rem))]',
    group: 'mt-3 border-border-default border-t pt-3 first:mt-0 first:border-t-0 first:pt-0',
    fieldset: 'm-0 border-0 p-0',
    draftsOption:
      'mt-3 flex cursor-pointer items-center justify-between gap-2 border-border-default border-t pt-3 text-md text-text-secondary first:mt-0 first:border-t-0 first:pt-0',
    workingOption:
      'mt-3 flex cursor-pointer items-center justify-between gap-2 border-border-default border-t pt-3 text-md text-text-secondary first:mt-0 first:border-t-0 first:pt-0',
    actions:
      'mt-3 flex justify-between border-border-default border-t pt-2.5 text-sm text-text-muted',
  },
})
