import { SnapshotEmpty, SnapshotHeader } from '@bottega/hub-views/snapshot'
import { hostedInsightStyles } from './hosted-insights.styles.ts'
import { HealthView, RoutingView } from './insights'

type Machine = { id: string; takenAt: string }
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
  if (pending) return <p className={hostedInsightStyles().muted()}>Loading routing...</p>
  if (error)
    return (
      <p data-tone="error" className={hostedInsightStyles().status()}>
        could not load: {error}
      </p>
    )
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
  if (pending) return <p className={hostedInsightStyles().muted()}>Loading health...</p>
  if (error)
    return (
      <p data-tone="error" className={hostedInsightStyles().status()}>
        could not load: {error}
      </p>
    )
  if (!snapshot) return <SnapshotEmpty title="Health" />
  return (
    <section>
      <SnapshotHeader
        title="Health"
        takenAt={snapshot.takenAt}
        machineId={machineId ?? snapshot.machineId}
        machines={snapshot.machines}
        onMachineChange={onMachineChange}
      />
      <HealthView data={snapshot.data} />
    </section>
  )
}
