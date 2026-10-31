import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { snapshotStyles } from './snapshot.styles.ts'

type Machine = {
  id: string
  takenAt: string
  machine: { id: string; shortName: string | null; displayName: string | null }
}

function asOf(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function SnapshotHeader({
  title,
  takenAt,
  machineId,
  machines,
  onMachineChange,
}: {
  title: string
  takenAt: string
  machineId: string
  machines: Machine[]
  onMachineChange: (machineId: string) => void
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const machineControl =
    machines.length > 1 ? (
      <div className={snapshotStyles().machineControl()}>
        Machine
        <Select
          label="Machine"
          size="sm"
          value={machineId}
          options={machines.map(({ id, machine }) => ({
            value: id,
            label: machine.displayName ?? machine.shortName ?? id,
          }))}
          onChange={onMachineChange}
        />
      </div>
    ) : null
  return (
    <PageHeader
      title={title}
      subtitle={`as of ${asOf(takenAt)}`}
      actions={phone ? <ToolbarBand scope={machineControl} /> : machineControl}
    />
  )
}

export function SnapshotEmpty({ title }: { title: string }) {
  return (
    <section>
      <PageHeader title={title} />
      <p className={snapshotStyles().empty()}>No {title.toLowerCase()} snapshot is available.</p>
    </section>
  )
}
