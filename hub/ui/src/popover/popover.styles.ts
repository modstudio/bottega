import { variant } from '../text/variant.ts'
import { type Align, panelClasses, placementClasses, type Side } from './placement.ts'

export const popoverStyles = (side: Side, align: Align) =>
  variant({ base: [placementClasses(side, align), panelClasses, 'max-w-sm p-3'] })
