import { Button } from '@bottega/hub-ui/button'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Select, type SelectOption } from '@bottega/hub-ui/listbox/select'
import { Segmented } from '@bottega/hub-ui/segmented'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@bottega/hub-ui/table'
import { TableCard } from '@bottega/hub-ui/table-card'
import { permissionListLabel } from '@bottega/hub-util/format'
import { ChevronDown, Plus, Save, Undo2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { CAPABILITY_ORDER, readablePermission } from './permission-capability.ts'
import { permissionMatrixStyles } from './permission-matrix.styles.ts'

/** A layer the matrix can show: the account, one project, or this machine's overlay. */
type MatrixLayer = 'account' | 'project' | 'machine'

/** Where a rule stands in a layer. `none` is unset; the machine adds `inherit` and `drop`. */
export type MatrixValue = 'none' | 'allow' | 'ask' | 'deny' | 'inherit' | 'drop'

export type MatrixColumn = {
  layer: MatrixLayer
  label: string
  /** Replaces the plain label, for a column that chooses what it shows. */
  heading?: ReactNode
}

export type MatrixRow = { rule: string; values: Partial<Record<MatrixLayer, MatrixValue>> }

export type PermissionEdit = {
  rule: string
  layer: MatrixLayer
  from: MatrixValue
  to: MatrixValue
}

export type MatrixSave = {
  run(edits: PermissionEdit[], reason: string): Promise<boolean>
  pending: boolean
  error: string | null
  /** Why saving is unavailable, shown in place of the save controls. */
  refusal?: string | null
}

const LIST_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'Not set' },
  ...(['allow', 'ask', 'deny'] as const).map((value) => ({
    value,
    label: permissionListLabel(value),
  })),
]

function machineOptions(accountValue: MatrixValue | undefined): SelectOption[] {
  return [
    { value: 'inherit', label: 'As account' },
    { value: 'allow', label: 'Allowed here' },
    { value: 'ask', label: 'Asks first here' },
    { value: 'deny', label: 'Blocked here' },
    {
      value: 'drop',
      label: 'Off here',
      note: 'Ignores the account rule on this machine',
      disabled: !accountValue || accountValue === 'none',
    },
  ]
}

/** A cell's edge says where the rule stands at a glance; an unsaved cell reads as information. */
const VALUE_TONE: Record<MatrixValue, string | undefined> = {
  none: undefined,
  inherit: undefined,
  allow: 'success',
  ask: 'warning',
  deny: 'error',
  drop: 'neutral',
}

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'allow', label: 'Allowed' },
  { value: 'ask', label: 'Asks first' },
  { value: 'deny', label: 'Blocked' },
  { value: 'unsaved', label: 'Unsaved' },
] as const

type Filter = (typeof FILTERS)[number]['value']

const empty = (layer: MatrixLayer): MatrixValue => (layer === 'machine' ? 'inherit' : 'none')

type Drafts = Record<string, MatrixValue>
const draftKey = (rule: string, layer: MatrixLayer) => `${layer}\u0000${rule}`

function matches(row: MatrixRow, label: string, query: string) {
  if (!query) return true
  const needle = query.toLowerCase()
  return row.rule.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
}

function passesFilter(values: MatrixValue[], unsaved: boolean, filter: Filter) {
  if (filter === 'all') return true
  if (filter === 'unsaved') return unsaved
  return values.includes(filter)
}

function useMatrixState(rows: readonly MatrixRow[], columns: readonly MatrixColumn[]) {
  const [drafts, setDrafts] = useState<Drafts>({})
  const [added, setAdded] = useState<string[]>([])
  const all = useMemo(() => {
    const known = new Set(rows.map((row) => row.rule))
    return [
      ...rows,
      ...added.filter((rule) => !known.has(rule)).map((rule) => ({ rule, values: {} })),
    ]
  }, [rows, added])
  const saved = (row: MatrixRow, layer: MatrixLayer) => row.values[layer] ?? empty(layer)
  const current = (row: MatrixRow, layer: MatrixLayer) =>
    drafts[draftKey(row.rule, layer)] ?? saved(row, layer)
  const edits: PermissionEdit[] = all.flatMap((row) =>
    columns.flatMap(({ layer }) => {
      const to = current(row, layer)
      const from = saved(row, layer)
      return to === from ? [] : [{ rule: row.rule, layer, from, to }]
    }),
  )
  const set = (row: MatrixRow, layer: MatrixLayer, value: MatrixValue) =>
    setDrafts((prior) => {
      const next = { ...prior }
      if (value === saved(row, layer)) delete next[draftKey(row.rule, layer)]
      else next[draftKey(row.rule, layer)] = value
      return next
    })
  const reset = () => {
    setDrafts({})
    setAdded([])
  }
  const add = (rule: string) =>
    setAdded((prior) => (prior.includes(rule) ? prior : [...prior, rule]))
  return { all, current, saved, edits, set, reset, add }
}

function AddRule({ onAdd }: { onAdd(rule: string): void }) {
  const [rule, setRule] = useState('')
  const submit = () => {
    if (!rule.trim()) return
    onAdd(rule.trim())
    setRule('')
  }
  return (
    <div className={permissionMatrixStyles().add()}>
      <Input
        aria-label="New rule"
        placeholder="New rule, such as Bash(make test:*)"
        value={rule}
        onChange={(event) => setRule(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <Button size="sm" disabled={!rule.trim()} onClick={submit}>
        <Plus /> Add rule
      </Button>
    </div>
  )
}

function SaveBar({
  count,
  save,
  onSave,
  onDiscard,
}: {
  count: number
  save: MatrixSave
  onSave(reason: string): Promise<boolean>
  onDiscard(): void
}) {
  const [reason, setReason] = useState('')
  if (save.refusal) return <p className={permissionMatrixStyles().refusal()}>{save.refusal}</p>
  if (count === 0)
    return (
      <p className={permissionMatrixStyles().refusal()}>
        Change any cell, then save with a reason.
      </p>
    )
  return (
    <div className={permissionMatrixStyles().saveBar()}>
      <span className={permissionMatrixStyles().saveCount()}>
        {count} unsaved {count === 1 ? 'change' : 'changes'}
      </span>
      <Input
        aria-label="Change reason"
        placeholder="Reason (required)"
        className={permissionMatrixStyles().reason()}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={!reason.trim() || save.pending}
        onClick={async () => {
          if (await onSave(reason.trim())) setReason('')
        }}
      >
        <Save /> {save.pending ? 'Saving...' : 'Save'}
      </Button>
      <Button size="sm" disabled={save.pending} onClick={onDiscard}>
        <Undo2 /> Discard
      </Button>
    </div>
  )
}

type MatrixState = ReturnType<typeof useMatrixState>

function RuleRow({
  row,
  label,
  columns,
  state,
}: {
  row: MatrixRow
  label: string
  columns: readonly MatrixColumn[]
  state: MatrixState
}) {
  return (
    <TableRow>
      <TableCell>
        <span className={permissionMatrixStyles().label()}>{label}</span>
        <code className={permissionMatrixStyles().rule()}>{row.rule}</code>
      </TableCell>
      {columns.map((column) => {
        const value = state.current(row, column.layer)
        const changed = value !== state.saved(row, column.layer)
        return (
          <TableCell key={column.layer}>
            <div
              data-tone={changed ? 'info' : VALUE_TONE[value]}
              className={permissionMatrixStyles({ changed, value }).cell()}
            >
              <Select
                size="sm"
                label={`${column.label}: ${label}`}
                value={value}
                options={
                  column.layer === 'machine'
                    ? machineOptions(state.current(row, 'account'))
                    : LIST_OPTIONS
                }
                onChange={(next) => state.set(row, column.layer, next as MatrixValue)}
              />
            </div>
          </TableCell>
        )
      })}
    </TableRow>
  )
}

function visibleGroups(
  state: MatrixState,
  columns: readonly MatrixColumn[],
  view: { query: string; filter: Filter; unsavedRules: ReadonlySet<string> },
) {
  const readable = state.all.map((row) => ({ row, readable: readablePermission(row.rule) }))
  return CAPABILITY_ORDER.map((capability) => ({
    capability,
    rows: readable
      .filter((entry) => entry.readable.capability.id === capability.id)
      .filter((entry) =>
        matches(entry.row, `${entry.readable.label} ${capability.label}`, view.query),
      )
      .filter(({ row }) =>
        passesFilter(
          columns.map(({ layer }) => state.current(row, layer)),
          view.unsavedRules.has(row.rule),
          view.filter,
        ),
      )
      .sort((a, b) => a.readable.label.localeCompare(b.readable.label)),
  })).filter((group) => group.rows.length > 0)
}

function groupSummary(values: MatrixValue[]) {
  const count = (value: MatrixValue) => values.filter((candidate) => candidate === value).length
  return [
    [count('allow'), 'allowed'],
    [count('ask'), 'ask first'],
    [count('deny'), 'blocked'],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

function GroupRow({
  label,
  hint,
  span,
  summary,
  unsaved,
  open,
  onToggle,
}: {
  label: string
  hint: string
  span: number
  summary: string
  unsaved: boolean
  open: boolean
  onToggle(): void
}) {
  const group = { open }
  return (
    <TableRow>
      <TableCell colSpan={span}>
        <button
          type="button"
          aria-expanded={open}
          className={permissionMatrixStyles(group).groupButton()}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden className={permissionMatrixStyles(group).groupChevron()} />
          <span className={permissionMatrixStyles(group).groupLabel()}>{label}</span>
          <span className={permissionMatrixStyles(group).groupHint()}>{hint}</span>
          <span className={permissionMatrixStyles(group).groupSummary()}>
            {unsaved ? 'Unsaved changes · ' : ''}
            {summary}
          </span>
        </button>
      </TableCell>
    </TableRow>
  )
}

/**
 * Every permission rule an agent runs under, grouped by what it lets an agent do, with one
 * column per layer. Edits are held until one save, which records one reason.
 */
export function PermissionMatrix({
  rows,
  columns,
  save,
  notice,
}: {
  rows: readonly MatrixRow[]
  columns: readonly MatrixColumn[]
  save: MatrixSave
  /** Shown above the rows, such as a check the stored rules failed. */
  notice?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const state = useMatrixState(rows, columns)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const narrowed = Boolean(query) || filter !== 'all'
  const unsavedRules = new Set(state.edits.map((edit) => edit.rule))

  const groups = visibleGroups(state, columns, { query, filter, unsavedRules })

  return (
    <TableCard
      heading={<AddRule onAdd={state.add} />}
      search={
        <Input
          aria-label="Search permissions"
          placeholder="Search permissions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      }
      filters={
        <Segmented
          label="Show"
          size="sm"
          value={filter}
          options={FILTERS}
          onChange={(value) => setFilter(value as Filter)}
        />
      }
      filtersActive={filter === 'all' ? 0 : 1}
      footer={
        <div className={permissionMatrixStyles().footer()}>
          {save.error ? <ErrorState title="Could not save" message={save.error} /> : null}
          <SaveBar
            count={state.edits.length}
            save={save}
            onDiscard={state.reset}
            onSave={async (reason) => {
              const ok = await save.run(state.edits, reason)
              if (ok) state.reset()
              return ok
            }}
          />
        </div>
      }
    >
      {notice}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Permission</TableHead>
            {columns.map((column) => (
              <TableHead key={column.layer} className={permissionMatrixStyles().column()}>
                {column.heading ?? column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length + 1} muted>
                No permission matches.
              </TableCell>
            </TableRow>
          ) : null}
          {groups.flatMap(({ capability, rows: grouped }) => [
            <GroupRow
              key={`group-${capability.id}`}
              label={capability.label}
              hint={capability.hint}
              span={columns.length + 1}
              summary={groupSummary(
                grouped.map(({ row }) => state.current(row, columns[0]!.layer)),
              )}
              unsaved={grouped.some(({ row }) => unsavedRules.has(row.rule))}
              open={narrowed || opened.has(capability.id)}
              onToggle={() =>
                setOpened((prior) => {
                  const next = new Set(prior)
                  if (!next.delete(capability.id)) next.add(capability.id)
                  return next
                })
              }
            />,
            ...(narrowed || opened.has(capability.id) ? grouped : []).map(({ row, readable }) => (
              <RuleRow
                key={row.rule}
                row={row}
                label={readable.label}
                columns={columns}
                state={state}
              />
            )),
          ])}
        </TableBody>
      </Table>
    </TableCard>
  )
}
