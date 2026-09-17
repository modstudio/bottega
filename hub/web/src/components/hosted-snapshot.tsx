import { PageHeader } from '@/components/design-system'

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
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Machine
            <select
              aria-label="Machine"
              className="h-8 border border-input bg-background px-2 text-foreground"
              value={machineId}
              onChange={(event) => onMachineChange(event.target.value)}
            >
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.id}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
    />
  )
}
