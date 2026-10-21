import { variant } from '@bottega/hub-ui/text/variant'

export const codeSectionStyles = variant({
  slots: {
    chevron: 'ml-auto text-text-muted transition-transform duration-(--duration-fast)',
    section: 'markdown mt-8',
    summary: 'flex w-full cursor-pointer items-center gap-2 text-left',
    count: 'font-mono text-sm text-text-muted tabular-nums',
  },
  variants: { open: { true: { chevron: 'rotate-180' } } },
})
