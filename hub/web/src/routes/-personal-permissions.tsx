import { hostedTrpc, queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@bottega/hub-ui/form-layout'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { permissionListLabel } from '@bottega/hub-util/format'
import {
  type MatrixColumn,
  type MatrixRow,
  type MatrixValue,
  type PermissionEdit,
  PermissionMatrix,
} from '@bottega/hub-views/machine-permissions/permission-matrix'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

const hosted = isHostedMode()

type List = 'allow' | 'ask' | 'deny'
type Lists = Record<List, string[]>
type Target = { user: true } | { project: string }
type Overlay = { additions: Lists; drop: Lists }

const LISTS: List[] = ['deny', 'ask', 'allow']
const isList = (value: MatrixValue): value is List =>
  value === 'allow' || value === 'ask' || value === 'deny'

function listOf(lists: Lists | undefined, rule: string): List | undefined {
  return lists ? LISTS.find((list) => lists[list].includes(rule)) : undefined
}

/** One row per rule any shown layer names, with where it stands in each layer. */
export function matrixRows(layers: {
  account?: Lists
  project?: Lists
  machine?: Overlay
}): MatrixRow[] {
  const rules = new Set<string>()
  for (const lists of [
    layers.account,
    layers.project,
    layers.machine?.additions,
    layers.machine?.drop,
  ])
    if (lists) for (const list of LISTS) for (const rule of lists[list]) rules.add(rule)
  return [...rules].map((rule) => {
    const values: MatrixRow['values'] = {}
    if (layers.account) values.account = listOf(layers.account, rule) ?? 'none'
    if (layers.project) values.project = listOf(layers.project, rule) ?? 'none'
    if (layers.machine)
      values.machine = listOf(layers.machine.drop, rule)
        ? 'drop'
        : (listOf(layers.machine.additions, rule) ?? 'inherit')
    return { rule, values }
  })
}

type CanonicalStep = {
  kind: 'canonical'
  target: Target
  list: List
  rule: string
  operation: 'add' | 'remove'
}
type MachineStep = {
  kind: 'machine'
  list: List
  rule: string
  operation: 'add' | 'remove' | 'drop' | 'undrop'
}
export type SaveStep = CanonicalStep | MachineStep

/**
 * The writes one cell change needs, removals first so a rule never sits in two lists. A machine
 * drop names the account list it suppresses.
 */
export function saveSteps(
  edit: PermissionEdit,
  context: { project: string; accountList: (rule: string) => List | undefined },
): SaveStep[] {
  const { rule, from, to } = edit
  if (edit.layer !== 'machine') {
    const target: Target = edit.layer === 'account' ? { user: true } : { project: context.project }
    return [
      ...(isList(from)
        ? [{ kind: 'canonical', target, list: from, rule, operation: 'remove' } as const]
        : []),
      ...(isList(to)
        ? [{ kind: 'canonical', target, list: to, rule, operation: 'add' } as const]
        : []),
    ]
  }
  const dropped = context.accountList(rule)
  const steps: SaveStep[] = []
  if (isList(from)) steps.push({ kind: 'machine', list: from, rule, operation: 'remove' })
  if (from === 'drop' && dropped)
    steps.push({ kind: 'machine', list: dropped, rule, operation: 'undrop' })
  if (isList(to)) steps.push({ kind: 'machine', list: to, rule, operation: 'add' })
  if (to === 'drop' && dropped)
    steps.push({ kind: 'machine', list: dropped, rule, operation: 'drop' })
  return steps
}

function useSettings(target: Target, enabled: boolean) {
  const local = useQuery({
    ...trpc.context.settings.get.queryOptions(target),
    enabled: enabled && !hosted,
  })
  const remote = useQuery({
    ...hostedTrpc.context.settings.get.queryOptions(target),
    enabled: enabled && hosted,
  })
  return hosted ? remote : local
}

function useProjects() {
  const local = useQuery({ ...trpc.context.projects.queryOptions(), enabled: !hosted })
  const remote = useQuery({ ...hostedTrpc.context.projects.queryOptions(), enabled: hosted })
  return hosted ? remote : local
}

/**
 * Saves every held change in order, carrying each target's new revision into its next write.
 * The store has no batch write, so a refusal partway leaves the earlier changes saved; the
 * message says how many went through.
 */
function useMatrixSave(revisions: { account: string | null; project: string | null }) {
  const localCanonical = useMutation(trpc.context.settings.permission.mutationOptions())
  const hostedCanonical = useMutation(hostedTrpc.context.settings.permission.mutationOptions())
  const canonical = hosted ? hostedCanonical : localCanonical
  const machine = useMutation(trpc.context.settings.machinePermission.mutationOptions())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settingsKey = hosted
    ? hostedTrpc.context.settings.pathKey()
    : trpc.context.settings.pathKey()

  async function run(steps: SaveStep[], reason: string) {
    setPending(true)
    setError(null)
    const revision = { ...revisions }
    let done = 0
    try {
      for (const step of steps) {
        if (step.kind === 'machine') {
          await machine.mutateAsync({ list: step.list, rule: step.rule, operation: step.operation })
        } else {
          const layer = 'user' in step.target ? 'account' : 'project'
          const result = await canonical.mutateAsync({
            target: step.target,
            list: step.list,
            rule: step.rule,
            operation: step.operation,
            reason,
            expectedRevision: revision[layer] ?? '',
          })
          revision[layer] = result.revision
        }
        done += 1
      }
      return true
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(
        done ? `${done} of ${steps.length} changes were saved before this: ${message}` : message,
      )
      return false
    } finally {
      setPending(false)
      await queryClient.invalidateQueries({ queryKey: settingsKey }).catch(() => undefined)
    }
  }
  return { run, pending, error }
}

function Lines({ children }: { children: string }) {
  return <span className="whitespace-pre-wrap">{children}</span>
}

type ProjectRow = { name: string; managedContext: boolean; worktreeNote: string | null }

function applyCommand(target: string, projects: ProjectRow[]) {
  if (target === 'user') return `${PLATFORM_SLUG} machine settings render --write --user --yes`
  const note = projects.find((row) => row.name === target)?.worktreeNote
  const command = `${PLATFORM_SLUG} machine settings render --write --project ${target} --yes`
  return note ? `${command}\n\nWorktree note:\n${note}` : command
}

type SettingsData = NonNullable<ReturnType<typeof useSettings>['data']>

function driftText(drift: NonNullable<SettingsData['drift']>) {
  const lines: string[] = []
  for (const name of ['allow', 'ask', 'deny'] as const) {
    lines.push(
      ...drift.rules[name].added.map((rule) => `Added to ${permissionListLabel(name)}: ${rule}`),
    )
    lines.push(
      ...drift.rules[name].removed.map(
        (rule) => `Removed from ${permissionListLabel(name)}: ${rule}`,
      ),
    )
  }
  const hook = (h: { event: string; matcher: string; fingerprint: string }) =>
    `${h.event} · ${h.matcher} · ${h.fingerprint}`
  lines.push(...drift.hooks.added.map((h) => `added hook: ${hook(h)}`))
  lines.push(...drift.hooks.removed.map((h) => `removed hook: ${hook(h)}`))
  lines.push(...drift.envKeys.added.map((name) => `added env key: ${name}`))
  lines.push(...drift.envKeys.removed.map((name) => `removed env key: ${name}`))
  return lines.join('\n')
}

/** What a layer carries besides permission rules, and how to apply it from a terminal. */
function LayerDetails({
  title,
  target,
  data,
  projects,
}: {
  title: string
  target: string
  data: SettingsData
  projects: ProjectRow[]
}) {
  const drift = data.drift ? driftText(data.drift) : ''
  return (
    <FieldSection title={title}>
      {hosted ? null : (
        <DisplayRow
          label="Available on this machine"
          value={data.file.exists ? 'Yes' : 'Not yet'}
        />
      )}
      <DisplayRow
        label={`Hooks (${data.settings.hooks.length})`}
        value={
          <span className="flex flex-col gap-1.5">
            <span className="text-sm text-text-muted">
              A hook runs an automatic check or action when an agent reaches a matching event.
            </span>
            <Lines>
              {data.settings.hooks
                .map((hook) => `${hook.event} · ${hook.matcher} · ${hook.fingerprint}`)
                .join('\n') || '—'}
            </Lines>
          </span>
        }
      />
      <DisplayRow
        label={`Environment keys (${data.settings.envKeys.length})`}
        value={data.settings.envKeys.join(', ') || '—'}
      />
      {drift ? <DisplayRow label="Differs on this machine" value={<Lines>{drift}</Lines>} /> : null}
      {hosted ? null : (
        <SettingBlock
          label="Apply now from a terminal"
          control={<Copyable value={applyCommand(target, projects)} />}
          hint="This page stores the settings; the machine writes its settings file when it applies them."
        />
      )}
    </FieldSection>
  )
}

function matrixColumns({
  project,
  projects,
  onProject,
  machine,
}: {
  project: string
  projects: string[]
  onProject(name: string): void
  machine: boolean
}): MatrixColumn[] {
  const columns: MatrixColumn[] = [{ layer: 'account', label: 'Your account' }]
  if (project)
    columns.push({
      layer: 'project',
      label: project,
      heading: (
        <Select
          size="sm"
          label="Project"
          value={project}
          options={projects.map((name) => ({ value: name, label: name }))}
          onChange={onProject}
        />
      ),
    })
  if (machine) columns.push({ layer: 'machine', label: 'This machine' })
  return columns
}

export function PersonalPermissionsPage() {
  const projects = useProjects()
  const managed = (projects.data ?? []).filter((project) => project.managedContext)
  const [projectChoice, setProjectChoice] = useState('')
  const project = projectChoice || managed[0]?.name || ''
  const account = useSettings({ user: true }, true)
  const projectSettings = useSettings({ project: project || '_' }, Boolean(project))
  const machine = hosted ? undefined : (account.data as { machine?: Overlay } | undefined)?.machine
  const save = useMatrixSave({
    account: account.data?.revision ?? null,
    project: projectSettings.data?.revision ?? null,
  })

  const columns = matrixColumns({
    project,
    projects: managed.map((row) => row.name),
    onProject: setProjectChoice,
    machine: Boolean(machine),
  })
  const rows = matrixRows({
    account: account.data?.settings.permissions,
    project: project ? projectSettings.data?.settings.permissions : undefined,
    machine,
  })
  const accountList = (rule: string) => listOf(account.data?.settings.permissions, rule)
  const findings = [...(account.data?.findings ?? []), ...(projectSettings.data?.findings ?? [])]
  const loadError = account.error ?? projectSettings.error

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-5 pb-12">
      <PageHeader
        title="Permissions"
        subtitle="What agents may do without asking, on your account, in a project and on this machine. Applied to every agent when a session starts."
      />
      {loadError ? (
        <ErrorState title="Could not load permissions" message={loadError.message} />
      ) : null}
      {account.data || loadError ? null : <EmptyState title="Loading permissions..." />}
      {account.data ? (
        <PermissionMatrix
          key={`${project}:${account.data.revision}:${projectSettings.data?.revision ?? ''}`}
          rows={rows}
          columns={columns}
          notice={findings.map((finding) => (
            <ErrorState
              key={`${finding.rule}-${finding.message}`}
              title="Check these permissions"
              message={`${finding.rule}: ${finding.message}`}
            />
          ))}
          save={{
            pending: save.pending,
            error: save.error,
            refusal: account.data.revision
              ? null
              : 'These settings have no stored revision to change yet.',
            run: (edits, reason) =>
              save.run(
                edits.flatMap((edit) => saveSteps(edit, { project, accountList })),
                reason,
              ),
          }}
        />
      ) : null}
      {account.data ? (
        <LayerDetails
          title="Your account: hooks and environment"
          target="user"
          data={account.data}
          projects={managed}
        />
      ) : null}
      {project && projectSettings.data ? (
        <LayerDetails
          title={`${project}: hooks and environment`}
          target={project}
          data={projectSettings.data}
          projects={managed}
        />
      ) : null}
    </div>
  )
}
