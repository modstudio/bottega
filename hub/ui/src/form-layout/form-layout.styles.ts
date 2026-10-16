import { variant } from '../text/variant.ts'

export const formLayoutStyles = variant({
  slots: {
    copyable: 'flex min-w-0 items-center gap-2',
    section: 'flex flex-col gap-4 border-border-subtle border-t pt-5 first:border-t-0 first:pt-0',
    sectionTitle: 'font-semibold text-md',
    sectionDescription: 'mt-1 text-sm text-text-secondary',
    field: 'flex flex-col gap-1.5',
    fieldLabel: 'font-medium text-sm text-text-secondary',
    fieldHint: 'text-sm text-text-muted',
    displayRow: '@container/row border-border-subtle border-b py-2.5 last:border-b-0',
    displayGrid: 'grid gap-1 @md/row:grid-cols-[9rem_minmax(0,1fr)] @md/row:gap-4',
    displayLabel: 'text-sm text-text-muted',
    displayValue: 'min-w-0 break-words',
    copyableValue: 'min-w-0 flex-1 break-all font-mono',
  },
  variants: { compact: { true: { copyable: 'text-sm text-text-muted' } } },
})
