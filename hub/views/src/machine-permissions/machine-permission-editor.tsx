import { Badge } from '@bottega/hub-ui/badge'
import { Button, IconButton } from '@bottega/hub-ui/button'
import { Input } from '@bottega/hub-ui/field/input'
import { Select } from '@bottega/hub-ui/listbox/select'
import { X } from 'lucide-react'
import { useState } from 'react'
import { MachineOptIn } from './machine-override.tsx'
import { machinePermissionEditorStyles } from './machine-permission-editor.styles.ts'

type PermissionList = 'allow' | 'ask' | 'deny'
type PermissionLists = Record<PermissionList, string[]>
type Overlay = { additions: PermissionLists; drop: PermissionLists }
type Lists = Overlay['additions']
type List = keyof Lists
type PermissionChangeAction = {
  run(
    input: {
      operation: 'add' | 'remove' | 'drop' | 'undrop'
      list: PermissionList
      rule: string
    },
    options: { onApplied(): void },
  ): Promise<boolean>
  pending: boolean
  error: string | null
}

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
    <div className={machinePermissionEditorStyles().rules()}>
      <div className={machinePermissionEditorStyles().ruleTitle()}>{title}</div>
      {rows.map(({ list, rule }) => (
        <div key={`${list} ${rule}`} className={machinePermissionEditorStyles().ruleRow()}>
          <Badge>{list}</Badge>
          <code className={machinePermissionEditorStyles().rule()}>{rule}</code>
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
export function MachinePermissionEditor({
  machine,
  change,
}: {
  machine: Overlay | undefined
  change: PermissionChangeAction
}) {
  return machine ? <OverlayEditor machine={machine} change={change} /> : null
}

function OverlayEditor({ machine, change }: { machine: Overlay; change: PermissionChangeAction }) {
  const names = listsOf(machine.additions)
  const [list, setList] = useState<List>(names[0] ?? 'allow')
  const [rule, setRule] = useState('')
  const runChange = (input: Parameters<PermissionChangeAction['run']>[0]) => {
    void change.run(input, { onApplied: () => setRule('') })
  }
  const empty = names.every(
    (name) => machine.additions[name].length === 0 && machine.drop[name].length === 0,
  )
  return (
    <MachineOptIn active={!empty}>
      {(close) => (
        <div className={machinePermissionEditorStyles().editor()}>
          <div className={machinePermissionEditorStyles().heading()}>
            <Badge tone="info">This machine</Badge>
            <span className={machinePermissionEditorStyles().explanation()}>
              Applies on this machine only, at the next session start.
            </span>
          </div>
          <OverlayRules
            title="Adds"
            lists={machine.additions}
            undo="Remove addition"
            pending={change.pending}
            onUndo={(name, value) => runChange({ operation: 'remove', list: name, rule: value })}
          />
          <OverlayRules
            title="Drops from your profile"
            lists={machine.drop}
            undo="Stop dropping"
            pending={change.pending}
            onUndo={(name, value) => runChange({ operation: 'undrop', list: name, rule: value })}
          />
          <div className={machinePermissionEditorStyles().fields()}>
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
            <p data-tone="error" className={machinePermissionEditorStyles().error()}>
              {change.error}
            </p>
          ) : null}
          <div className={machinePermissionEditorStyles().actions()}>
            <Button
              disabled={!rule.trim() || change.pending}
              onClick={() => runChange({ operation: 'add', list, rule })}
            >
              Add on this machine
            </Button>
            <Button
              disabled={!rule.trim() || change.pending}
              onClick={() => runChange({ operation: 'drop', list, rule })}
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
