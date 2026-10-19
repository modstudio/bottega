import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'

type Machine = { id: string; takenAt: string }

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
      <div className="flex items-center gap-2 text-sm text-text-muted">
        Machine
        <Select
          label="Machine"
          size="sm"
          value={machineId}
          options={machines.map((machine) => ({ value: machine.id, label: machine.id }))}
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
      <p className="text-text-muted">No {title.toLowerCase()} snapshot is available.</p>
    </section>
  )
}
