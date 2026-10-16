import { controlClasses } from '../field/control.ts'
import { panelClasses, placementClasses } from '../popover/placement.ts'
import { variant } from '../text/variant.ts'

export const selectStyles = variant({
  slots: {
    trigger: [controlClasses, 'inline-flex min-w-40 items-center justify-between gap-2 text-left'],
    panel: [placementClasses('bottom', 'start'), panelClasses, 'max-h-80 overflow-y-auto py-1'],
    option: 'flex min-h-control-md cursor-pointer items-center gap-2 px-3 py-1.5',
    check: 'size-4 shrink-0',
    slot1: 'truncate',
    slot2: 'size-4 shrink-0 text-icon-muted',
    slot3: 'min-w-0 flex-1 truncate',
    slot4: 'text-sm text-text-muted',
  },
  variants: {
    size: {
      sm: { trigger: 'h-control-sm px-2 text-sm' },
      md: { trigger: 'h-control-md px-3' },
    },
    active: { true: { option: 'bg-control-hover' } },
    disabled: { true: { option: 'cursor-not-allowed text-text-disabled' } },
    selected: { true: { check: 'opacity-100' }, false: { check: 'opacity-0' } },
  },
  defaultVariants: { size: 'md' },
})
