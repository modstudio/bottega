import { variant } from '../text/variant.ts'

export const checkboxStyles = variant({
  slots: {
    root: 'relative inline-grid size-4 shrink-0 place-items-center',
    input:
      'peer col-start-1 row-start-1 size-4 cursor-pointer border border-border-strong bg-surface-page transition-colors checked:border-accent-fill checked:bg-accent-fill indeterminate:border-accent-fill indeterminate:bg-accent-fill hover:border-text-muted disabled:cursor-not-allowed disabled:border-border-default disabled:bg-control-disabled disabled:checked:opacity-50',
    mark: 'pointer-events-none col-start-1 row-start-1 size-3 text-accent-on-fill opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100',
  },
})
