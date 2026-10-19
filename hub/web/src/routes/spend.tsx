import { useSpend } from '@bottega/hub-data/use-spend'
import { useWindowState } from '@bottega/hub-data/window'
import { createFileRoute } from '@tanstack/react-router'
import { InsightView } from '@/routes/-insight-view'

export const Route = createFileRoute('/spend')({ component: SpendRoute })

function SpendRoute() {
  const window = useWindowState()
  const query = useSpend({ hours: window.hours, filters: window.filters })
  return (
    <InsightView
      name="spend"
      response={query.data}
      pending={query.isPending}
      error={query.error?.message ?? null}
    />
  )
}
