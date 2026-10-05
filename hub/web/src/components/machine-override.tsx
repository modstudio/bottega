import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button, IconButton, TextButton } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'

/**
 * One setting's override on this machine. A row follows the profile until the operator
 * opts in, so the control stays out of the way where no override exists.
 */
export function MachineOverride({
  label,
  value,
  options,
  pending,
  onSet,
  onRemove,
}: {
  label: string
  value: string | undefined
  options: readonly { value: string; label: string }[]
  pending: boolean
  onSet(value: string): void
  onRemove(): void
}) {
  const [open, setOpen] = useState(false)
  if (value === undefined && !open) {
    return (
      <TextButton className="self-start" onClick={() => setOpen(true)}>
        Override on this machine
      </TextButton>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone="info">This machine</Badge>
      <Select
        label={`${label} on this machine`}
        size="sm"
        value={value ?? ''}
        options={options}
        onChange={onSet}
      />
      {value === undefined ? (
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            onRemove()
          }}
        >
          Remove
        </Button>
      )}
    </span>
  )
}

const LISTS = ['allow', 'ask', 'deny'] as const
type List = (typeof LISTS)[number]
type Lists = Record<List, string[]>

function OverlayRules({
  title,
  lists,
  undo,
  pending,
  onUndo,
}: {
  title: string
  lists: Lists
  undo: string
  pending: boolean
  onUndo(list: List, rule: string): void
}) {
  const rows = LISTS.flatMap((list) => lists[list].map((rule) => ({ list, rule })))
  if (rows.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="text-sm text-text-muted">{title}</div>
      {rows.map(({ list, rule }) => (
        <div key={`${list} ${rule}`} className="flex min-w-0 items-center gap-2">
          <Badge>{list}</Badge>
          <code className="min-w-0 flex-1 break-all font-mono">{rule}</code>
          <IconButton
            size="sm"
            label={`${undo}: ${rule}`}
            disabled={pending}
            onClick={() => onUndo(list, rule)}
          >
            <X />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

/** This machine's permission overlay: rules it adds and profile rules it drops. */
export function MachinePermissionOverlay({
  machine,
}: {
  machine: { additions: Lists; drop: Lists } | undefined
}) {
  return machine ? <MachinePermissionOverlayPanel machine={machine} /> : null
}

function MachinePermissionOverlayPanel({
  machine,
}: {
  machine: { additions: Lists; drop: Lists }
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<List>('allow')
  const [rule, setRule] = useState('')
  const change = useMutation(
    trpc.context.settings.machinePermission.mutationOptions({
      onSuccess: async () => {
        setRule('')
        await queryClient.invalidateQueries({ queryKey: trpc.context.settings.pathKey() })
      },
    }),
  )
  const count = LISTS.reduce(
    (sum, name) => sum + machine.additions[name].length + machine.drop[name].length,
    0,
  )
  if (count === 0 && !open) {
    return <TextButton onClick={() => setOpen(true)}>Override on this machine</TextButton>
  }
  return (
    <div className="space-y-3 border-border-subtle border-l-2 pl-4">
      <div className="flex items-center gap-2">
        <Badge tone="info">This machine</Badge>
        <span className="text-sm text-text-muted">
          Applies on this machine only, at the next session start.
        </span>
      </div>
      <OverlayRules
        title="Adds"
        lists={machine.additions}
        undo="Remove addition"
        pending={change.isPending}
        onUndo={(name, value) => change.mutate({ operation: 'remove', list: name, rule: value })}
      />
      <OverlayRules
        title="Drops from your profile"
        lists={machine.drop}
        undo="Stop dropping"
        pending={change.isPending}
        onUndo={(name, value) => change.mutate({ operation: 'undrop', list: name, rule: value })}
      />
      <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
        <Select
          label="Machine permission list"
          value={list}
          options={LISTS.map((name) => ({ value: name, label: name }))}
          onChange={(value) => setList(value as List)}
        />
        <Input
          aria-label="Machine permission rule"
          placeholder="Permission rule"
          value={rule}
          onChange={(event) => setRule(event.target.value)}
        />
      </div>
      {change.error ? (
        <p data-tone="error" className="whitespace-pre-wrap text-status-text">
          {change.error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!rule.trim() || change.isPending}
          onClick={() => change.mutate({ operation: 'add', list, rule })}
        >
          Add on this machine
        </Button>
        <Button
          disabled={!rule.trim() || change.isPending}
          onClick={() => change.mutate({ operation: 'drop', list, rule })}
        >
          Drop on this machine
        </Button>
        {count === 0 ? (
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}
