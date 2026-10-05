import { useMutation } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { X } from 'lucide-react'
import { useState } from 'react'
import { MachineOptIn } from '@/components/machine-override'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button, IconButton } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import type { AppRouter } from '../../../src/trpc/router.ts'

type Overlay = NonNullable<inferRouterOutputs<AppRouter>['context']['settings']['get']['machine']>
type Lists = Overlay['additions']
type List = keyof Lists

const listsOf = (lists: Lists) => Object.keys(lists) as List[]

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
  const rows = listsOf(lists).flatMap((list) => lists[list].map((rule) => ({ list, rule })))
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

/** Edits this machine's permission overlay: rules it adds and profile rules it drops. */
export function MachinePermissionEditor({ machine }: { machine: Overlay | undefined }) {
  return machine ? <OverlayEditor machine={machine} /> : null
}

function OverlayEditor({ machine }: { machine: Overlay }) {
  const names = listsOf(machine.additions)
  const [list, setList] = useState<List>(names[0] ?? 'allow')
  const [rule, setRule] = useState('')
  const change = useMutation(
    trpc.context.settings.machinePermission.mutationOptions({
      onSuccess: async () => {
        setRule('')
        await queryClient.invalidateQueries({ queryKey: trpc.context.settings.pathKey() })
      },
    }),
  )
  const empty = names.every(
    (name) => machine.additions[name].length === 0 && machine.drop[name].length === 0,
  )
  return (
    <MachineOptIn active={!empty}>
      {(close) => (
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
            onUndo={(name, value) =>
              change.mutate({ operation: 'remove', list: name, rule: value })
            }
          />
          <OverlayRules
            title="Drops from your profile"
            lists={machine.drop}
            undo="Stop dropping"
            pending={change.isPending}
            onUndo={(name, value) =>
              change.mutate({ operation: 'undrop', list: name, rule: value })
            }
          />
          <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
            <Select
              label="Machine permission list"
              value={list}
              options={names.map((name) => ({ value: name, label: name }))}
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
            {empty ? (
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </MachineOptIn>
  )
}
