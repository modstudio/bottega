import { useHealth } from '@bottega/hub-data/use-health'
import { useWindowState } from '@bottega/hub-data/window'
import { HostedHealth } from '@bottega/hub-views/insights/hosted-insights'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
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
