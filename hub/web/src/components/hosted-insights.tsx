import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { SnapshotHeader } from '@/components/hosted-snapshot'
import { HealthView, RoutingView } from '@/components/insight-view'
import { trpc } from '@/trpc/client'

export function HostedRouting() {
  const [machineId, setMachineId] = useState<string>()
  const query = useQuery(trpc.record.routing.queryOptions({ machineId }))
  if (query.isPending) return <p className="text-muted-foreground">Loading routing...</p>
  if (query.error) return <p className="text-destructive">could not load: {query.error.message}</p>
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
  if (query.isPending) return <p className="text-muted-foreground">Loading health...</p>
  if (query.error) return <p className="text-destructive">could not load: {query.error.message}</p>
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
