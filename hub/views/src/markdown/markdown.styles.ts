import { variant } from '@bottega/hub-ui/text/variant'

export const markdownStyles = variant({
  slots: {
    audience: 'font-mono text-text-muted text-xs',
    frontmatterError: 'text-status-text text-sm',
    frontmatterItems: 'flex flex-wrap gap-2',
    frontmatterNested: 'ml-3',
    frontmatterValue: 'whitespace-pre-wrap',
    root: 'markdown',
  },
})
