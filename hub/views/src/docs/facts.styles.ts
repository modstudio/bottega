import { variant } from '@bottega/hub-ui/text/variant'

export const factsStyles = variant({
  slots: {
    summary: 'm-0 text-text-secondary',
    summaryError: 'mt-2 text-sm text-status-text',
    revision:
      'block w-full cursor-pointer border-border-default border-t py-2 text-left text-sm text-text-muted hover:text-text-primary aria-current:font-medium aria-current:text-text-primary',
    facts: 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md',
    summaryLabel: 'text-text-muted',
    summarySource: 'mt-1 block text-xs',
    audienceLabel: 'text-text-muted',
    audienceValue: 'm-0 text-text-secondary',
    typeLabel: 'text-text-muted',
    typeValue: 'm-0 text-text-secondary',
    subjectLabel: 'text-text-muted',
    subjectValue: 'm-0 text-text-secondary',
    relatedLabel: 'text-text-muted',
    relatedValue: 'm-0 text-text-secondary',
  },
  variants: { derived: { true: { summary: 'text-text-muted' } } },
})
