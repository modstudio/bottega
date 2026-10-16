export type Side = 'top' | 'bottom' | 'right'
export type Align = 'start' | 'end'

const areas: Record<`${Side}-${Align}`, string> = {
  'bottom-start': '[position-area:block-end_span-inline-end]',
  'bottom-end': '[position-area:block-end_span-inline-start]',
  'top-start': '[position-area:block-start_span-inline-end]',
  'top-end': '[position-area:block-start_span-inline-start]',
  'right-start': '[position-area:inline-end_span-block-end]',
  'right-end': '[position-area:inline-end_span-block-start]',
}

/**
 * Anchored placement in the top layer. `position-try-fallbacks` flips the popup
 * when it would leave the viewport. Above or below, the minimum width follows
 * the trigger; beside it, the popup keeps its own width.
 */
export function placementClasses(side: Side, align: Align): string {
  const beside = side === 'right'
  return [
    areas[`${side}-${align}`],
    '[inset:auto] [position-try-fallbacks:flip-block,flip-inline]',
    beside ? 'mx-1' : 'my-1 [min-width:anchor-size(width)]',
  ].join(' ')
}

export const panelClasses =
  'border border-border-default bg-surface-overlay text-text-primary shadow-overlay transition-[opacity,translate] duration-(--duration-fast) starting:-translate-y-0.5 starting:opacity-0'
