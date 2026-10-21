import { variant } from '@bottega/hub-ui/text/variant'

export const markdownStyles = variant({
  slots: {
    audience: 'font-mono text-text-muted text-xs',
    frontmatter:
      'mb-8 border border-border-default bg-surface-sunken px-4 py-3.5 font-mono text-sm text-text-secondary leading-[1.7]',
    frontmatterDetail: 'm-0 min-w-0',
    frontmatterError: 'text-status-text text-sm',
    frontmatterItems: 'flex flex-wrap gap-x-4',
    frontmatterKey: 'text-text-muted',
    frontmatterList: 'm-0 grid grid-cols-[max-content_1fr] gap-x-6',
    frontmatterValue: 'whitespace-pre-wrap',
    root: 'markdown',
  },
  variants: {
    nested: { true: { frontmatterList: 'mt-1 ml-3' } },
  },
})
