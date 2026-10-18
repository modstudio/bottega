import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { useHostedHealth } from '@bottega/hub-data/use-health'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { HostedHealth } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'

export const Route = createFileRoute('/health')({
  component: () => (isHostedMode() ? <HostedHealthRoute /> : <InsightView name="health" />),
})

function HostedHealthRoute() {
  const [machineId, setMachineId] = useState<string>()
  const data = useHostedHealth(machineId)
  return <HostedHealth {...data} machineId={machineId} onMachineChange={setMachineId} />
}
