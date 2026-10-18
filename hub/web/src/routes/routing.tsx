import { useRouting } from '@bottega/hub-data/use-routing'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { HostedRouting } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'
import { useWindowState } from '@/lib/window'

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
