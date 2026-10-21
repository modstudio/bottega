import { variant } from '@bottega/hub-ui/text/variant'

export const docFieldControlsStyles = variant({
  slots: {
    fieldTrigger:
      'group flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 text-left hover:text-text-primary disabled:cursor-default',
    summary: '',
    error: 'm-0 mt-1 text-sm text-status-text',
    fieldLabel: 'text-text-muted',
    fieldValue: 'm-0 min-w-0 text-text-secondary',
    chevronDown: 'shrink-0 text-icon-muted group-hover:text-text-primary group-disabled:invisible',
    selectedValue: 'min-w-0 truncate',
    audienceList: 'flex min-h-6 min-w-0 flex-wrap items-center gap-1',
    emptyValue: 'text-text-muted',
    audienceOptions: 'grid gap-1.5',
    audienceOption: 'flex items-center gap-2 text-md text-text-secondary',
    kindValue: 'min-w-0 truncate',
    fixedScope: 'inline-flex items-center gap-1.5',
    scopePicker: 'inline-flex items-center gap-1.5',
    scopeOption:
      'inline-flex cursor-pointer items-center gap-1.5 rounded-sm hover:text-text-primary disabled:cursor-default',
    summarySource: 'mt-1 block text-xs',
    fields: 'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 text-md',
    sourceFile: 'inline-flex max-w-full items-center gap-2',
    sourceFilePath: 'min-w-0 break-all',
    actions: 'mt-3 flex items-center gap-2',
    input: 'flex-1',
  },
  variants: { derived: { true: { summary: 'text-text-muted' } } },
})
