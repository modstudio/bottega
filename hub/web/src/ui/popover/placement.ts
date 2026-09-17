export type Side = 'top' | 'bottom'
export type Align = 'start' | 'end'

/**
 * Anchored placement in the top layer. `position-try-fallbacks` flips the popup
 * when it would leave the viewport; the minimum width follows the trigger.
 */
export function placementClasses(side: Side, align: Align): string {
  const area = {
    'bottom-start': '[position-area:block-end_span-inline-end]',
    'bottom-end': '[position-area:block-end_span-inline-start]',
    'top-start': '[position-area:block-start_span-inline-end]',
    'top-end': '[position-area:block-start_span-inline-start]',
  }[`${side}-${align}` as const]
  return `${area} [inset:auto] [position-try-fallbacks:flip-block,flip-inline] my-1 [min-width:anchor-size(width)]`
}

export const panelClasses =
  'border border-border-default bg-surface-overlay text-text-primary shadow-overlay transition-[opacity,translate] duration-(--duration-fast) starting:-translate-y-0.5 starting:opacity-0'
