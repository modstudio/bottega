import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { useHostedRouting } from '@bottega/hub-data/use-routing'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { HostedRouting } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'

export const Route = createFileRoute('/routing')({
  component: () => (isHostedMode() ? <HostedRoutingRoute /> : <InsightView name="routing" />),
})

function HostedRoutingRoute() {
  const [machineId, setMachineId] = useState<string>()
  const data = useHostedRouting(machineId)
  return <HostedRouting {...data} machineId={machineId} onMachineChange={setMachineId} />
}
