import { InsightView as InsightPresentation } from '@bottega/hub-views/insights'
import type { ComponentProps } from 'react'
import { setWorkCounts } from '@/lib/window'
import { WindowControl } from '@/routes/-window-controls'

export function InsightView(
  props: Omit<ComponentProps<typeof InsightPresentation>, 'windowControl' | 'onCountsChange'>,
) {
  return (
    <InsightPresentation
      {...props}
      windowControl={<WindowControl />}
      onCountsChange={setWorkCounts}
    />
  )
}
