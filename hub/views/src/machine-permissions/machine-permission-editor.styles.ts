import { variant } from '@bottega/hub-ui/text/variant'

export const machinePermissionEditorStyles = variant({
  slots: {
    rules: 'space-y-1',
    ruleTitle: 'text-sm text-text-muted',
    ruleRow: 'flex min-w-0 items-center gap-2',
    rule: 'min-w-0 flex-1 break-all font-mono',
    editor: 'space-y-3 border-border-subtle border-l-2 pl-4',
    heading: 'flex items-center gap-2',
    explanation: 'text-sm text-text-muted',
    fields: 'grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]',
    error: 'whitespace-pre-wrap text-status-text',
    actions: 'flex flex-wrap gap-2',
  },
})
