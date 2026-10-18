import { useRatio } from '@bottega/hub-data/use-ratio'
import { createFileRoute } from '@tanstack/react-router'
import { InsightView } from '@/components/insight-view'
import { useWindowState } from '@/lib/window'

export const Route = createFileRoute('/ratio')({ component: RatioRoute })

function RatioRoute() {
  const window = useWindowState()
  const query = useRatio({ hours: window.hours, filters: window.filters })
  return (
    <InsightView
      name="ratio"
      response={query.data}
      pending={query.isPending}
      error={query.error?.message ?? null}
    />
  )
}
