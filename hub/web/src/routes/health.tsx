import { useHealth } from '@bottega/hub-data/use-health'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { HostedHealth } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'
import { useWindowState } from '@/lib/window'

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
