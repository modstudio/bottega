import { useRouting } from '@bottega/hub-data/use-routing'
import { useWindowState } from '@bottega/hub-data/window'
import { HostedRouting } from '@bottega/hub-views/insights/hosted-insights'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { InsightView } from '@/routes/-insight-view'

export const Route = createFileRoute('/routing')({
  component: RoutingRoute,
})

function RoutingRoute() {
  const [machineId, setMachineId] = useState<string>()
  const window = useWindowState()
  const result = useRouting({ hours: window.hours, filters: window.filters }, machineId)
  return result.kind === 'hosted' ? (
    <HostedRouting {...result} machineId={machineId} onMachineChange={setMachineId} />
  ) : (
    <InsightView name="routing" {...result} />
  )
}
