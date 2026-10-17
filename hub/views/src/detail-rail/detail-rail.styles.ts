import { variant } from '@bottega/hub-ui/text/variant'

export const detailRailStyles = variant({
  slots: {
    aside:
      'hidden px-5 pb-8 lg:sticky lg:top-(--docs-stick) lg:block lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:overflow-y-auto',
    top: 'pt-4',
    tabs: 'sticky top-0 z-10 bg-surface-page pt-4',
    panel: 'pt-5',
  },
})
