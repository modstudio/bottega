import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'

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
  return (
    <PageHeader
      title={title}
      subtitle={`as of ${asOf(takenAt)}`}
      actions={
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
      }
    />
  )
}
