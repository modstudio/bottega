import { useHealth } from '@bottega/hub-data/use-health'
import { HostedHealth } from '@bottega/hub-views/insights/hosted-insights'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useWindowState } from '@/lib/window'
import { InsightView } from '@/routes/-insight-view'

export const Route = createFileRoute('/health')({
  component: HealthRoute,
})

function HealthRoute() {
  const [machineId, setMachineId] = useState<string>()
  const window = useWindowState()
  const result = useHealth({ hours: window.hours, filters: window.filters }, machineId)
  return result.kind === 'hosted' ? (
    <HostedHealth {...result} machineId={machineId} onMachineChange={setMachineId} />
  ) : (
    <InsightView name="health" {...result} />
  )
}
