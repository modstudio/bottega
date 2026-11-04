import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { type Machine, SnapshotEmpty, SnapshotHeader } from '../snapshot/snapshot.tsx'
import { HealthView, RoutingView } from './insights'

type Snapshot<Data> = {
  takenAt: string
  machineId: string
  machines: Machine[]
  data: Data
}

type HostedInsightProps<Data> = {
  snapshot: Snapshot<Data> | null
  pending: boolean
  error: string | null
  machineId: string | undefined
  onMachineChange(machineId: string): void
}

export function HostedRouting({
  snapshot,
  pending,
  error,
  machineId,
  onMachineChange,
}: HostedInsightProps<Parameters<typeof RoutingView>[0]['data']>) {
  if (pending) return <EmptyState title="Loading routing..." />
  if (error) return <ErrorState title="Could not load routing" message={error} />
  if (!snapshot) return <SnapshotEmpty title="Routing" />
  return (
    <section>
      <SnapshotHeader
        title="Routing"
        takenAt={snapshot.takenAt}
        machineId={machineId ?? snapshot.machineId}
        machines={snapshot.machines}
        onMachineChange={onMachineChange}
      />
      <RoutingView data={snapshot.data} />
    </section>
  )
}

export function HostedHealth({
  snapshot,
  pending,
  error,
  machineId,
  onMachineChange,
}: HostedInsightProps<Parameters<typeof HealthView>[0]['data']>) {
  if (pending) return <EmptyState title="Loading machines..." />
  if (error) return <ErrorState title="Could not load machines" message={error} />
  if (!snapshot) return <SnapshotEmpty title="Machines" />
  return (
    <section>
      <SnapshotHeader
        title="Machines"
        takenAt={snapshot.takenAt}
        machineId={machineId ?? snapshot.machineId}
        machines={snapshot.machines}
        onMachineChange={onMachineChange}
      />
      <HealthView data={snapshot.data} />
    </section>
  )
}
