import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { SnapshotEmpty, SnapshotHeader } from '@/components/hosted-snapshot'
import { HealthView, RoutingView } from '@/components/insight-view'
import { trpc } from '@/trpc/client'

export function HostedRouting() {
  const [machineId, setMachineId] = useState<string>()
  const query = useQuery(trpc.record.routing.queryOptions({ machineId }))
  if (query.isPending) return <p className="text-text-muted">Loading routing...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  if (!query.data) return <SnapshotEmpty title="Routing" />
  return (
    <section>
      <SnapshotHeader
        title="Routing"
        takenAt={query.data.takenAt}
        machineId={query.data.machineId}
        machines={query.data.machines}
        onMachineChange={setMachineId}
      />
      <RoutingView data={query.data.data} />
    </section>
  )
}

export function HostedHealth() {
  const [machineId, setMachineId] = useState<string>()
  const query = useQuery(trpc.record.health.queryOptions({ machineId }))
  if (query.isPending) return <p className="text-text-muted">Loading health...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  if (!query.data) return <SnapshotEmpty title="Health" />
  return (
    <section>
      <SnapshotHeader
        title="Health"
        takenAt={query.data.takenAt}
        machineId={query.data.machineId}
        machines={query.data.machines}
        onMachineChange={setMachineId}
      />
      <HealthView data={query.data.data} />
    </section>
  )
}
