import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MachineOverride, MachinePermissionOverlay } from '@/components/machine-override'
import { Markdown } from '@/components/markdown'
import { isHostedMode } from '@/lib/hub-mode'
import { hostedTrpc, queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button, TextButton } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@/ui/form-layout/form-layout'
import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'
import { Segmented } from '@/ui/segmented/segmented'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_VALUES,
  type AutonomyPreset,
  type AutonomyValue,
} from '../../../../shared/autonomy'
import {
  RELEASE_AUTONOMY_VALUES,
  type ReleaseAutonomyValue,
} from '../../../../shared/release-autonomy'

export const Route = createFileRoute('/context')({ component: ManagedContextPage })

/**
 * The local and hosted servers mount different routers, so every read and write names the
 * proxy for its mode and the page uses only fields both shapes carry.
 */
const hosted = isHostedMode()

const APPLY_NOTE = 'Each machine applies these at session start (orch settings apply).'

const capitalized = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1)}`

const presetOptions = AUTONOMY_PRESETS.map((value) => ({ value, label: capitalized(value) }))

const stageValues = AUTONOMY_VALUES.map((value) => ({ value, label: capitalized(value) }))

const FROM_PRESET = { value: '', label: 'From preset', disabled: true }

const releaseValues = RELEASE_AUTONOMY_VALUES.map((value) => ({ value, label: capitalized(value) }))

const rulingsValues = (['agent', 'user'] as const).map((value) => ({
  value,
  label: capitalized(value),
}))

function ErrorText({ message }: { message: string }) {
  return (
    <p data-tone="error" className="whitespace-pre-wrap text-status-text">
      {message}
    </p>
  )
}

function Lines({ children }: { children: string }) {
  return <span className="whitespace-pre-wrap">{children}</span>
}

function RemoveCanonButton({
  hidden,
  disabled,
  onClick,
}: {
  hidden: boolean
  disabled: boolean
  onClick: () => void
}) {
  if (hidden) return null
  return (
    <Button variant="danger" disabled={disabled} onClick={onClick}>
      <Trash2 size={14} /> Remove
    </Button>
  )
}

export function ManagedContextPage() {
  const localProjects = useQuery({ ...trpc.context.projects.queryOptions(), enabled: !hosted })
  const hostedProjects = useQuery({
    ...hostedTrpc.context.projects.queryOptions(),
    enabled: hosted,
  })
  const projects = hosted ? hostedProjects : localProjects
  const localCanon = useQuery({ ...trpc.context.userCanon.list.queryOptions(), enabled: !hosted })
  const hostedCanon = useQuery({
    ...hostedTrpc.context.userCanon.list.queryOptions(),
    enabled: hosted,
  })
  const canon = hosted ? hostedCanon : localCanon
  const [projectChoice, setProjectChoice] = useState('')
  const [settingsChoice, setSettingsChoice] = useState('user')
  const selectedProject = projectChoice || projects.data?.[0]?.name || ''
  const managedProjects = projects.data?.filter((project) => project.managedContext) ?? []
  const projectOptions = (projects.data ?? []).map((project) => ({
    value: project.name,
    label: project.name,
  }))
  const settingsOptions = [
    { value: 'user', label: 'User' },
    ...managedProjects.map((project) => ({ value: project.name, label: project.name })),
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-5 pb-12">
      <PageHeader
        title="Agent settings"
        subtitle="Autonomy, user canon and permissions, the same on every machine"
      />
      {hosted ? (
        <HostedAutonomySection
          project={selectedProject}
          options={projectOptions}
          onProject={setProjectChoice}
        />
      ) : (
        <AutonomySection
          project={selectedProject}
          options={projectOptions}
          onProject={setProjectChoice}
        />
      )}
      <UserCanonSection rows={canon.data} pending={canon.isPending} error={canon.error?.message} />
      <ManagedSettingsSection
        target={settingsChoice}
        options={settingsOptions}
        projects={managedProjects}
        onTarget={setSettingsChoice}
      />
    </div>
  )
}

type CanonRows = Array<{
  slug: string
  title: string
  body: string
  revision: string | null
  updated_at: string
}>

/** User canon reads and writes against the server this page is talking to. */
function useUserCanonApi(
  selected: string,
  on: { saved(row: { slug: string }): void; removed(): void },
) {
  const input = { slug: selected || '_' }
  const localDetail = useQuery({
    ...trpc.context.userCanon.get.queryOptions(input),
    enabled: !hosted && Boolean(selected),
  })
  const hostedDetail = useQuery({
    ...hostedTrpc.context.userCanon.get.queryOptions(input),
    enabled: hosted && Boolean(selected),
  })
  const detail = hosted ? hostedDetail : localDetail
  const canonKey = hosted
    ? hostedTrpc.context.userCanon.pathKey()
    : trpc.context.userCanon.pathKey()
  const saved = async (row: { slug: string }) => {
    await queryClient.invalidateQueries({ queryKey: canonKey })
    on.saved(row)
  }
  const removed = async () => {
    on.removed()
    await queryClient.invalidateQueries({ queryKey: canonKey })
  }
  const localSave = useMutation(trpc.context.userCanon.set.mutationOptions({ onSuccess: saved }))
  const hostedSave = useMutation(
    hostedTrpc.context.userCanon.set.mutationOptions({ onSuccess: saved }),
  )
  const save = hosted ? hostedSave : localSave
  const localRemove = useMutation(
    trpc.context.userCanon.remove.mutationOptions({ onSuccess: removed }),
  )
  const hostedRemove = useMutation(
    hostedTrpc.context.userCanon.remove.mutationOptions({ onSuccess: removed }),
  )
  const remove = hosted ? hostedRemove : localRemove
  return { detail, save, remove }
}

export function UserCanonSection({
  rows,
  pending,
  error,
}: {
  rows: CanonRows | undefined
  pending: boolean
  error?: string
}) {
  const [choice, setChoice] = useState('')
  const [creating, setCreating] = useState(false)
  const selected = choice || rows?.[0]?.slug || ''
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')
  const { detail, save, remove } = useUserCanonApi(selected, {
    saved: (row) => {
      setChoice(row.slug)
      setCreating(false)
      setReason('')
    },
    removed: () => {
      setChoice('')
      setReason('')
    },
  })

  useEffect(() => {
    if (!detail.data || creating) return
    setSlug(detail.data.slug)
    setTitle(detail.data.title)
    setBody(detail.data.body)
  }, [detail.data, creating])

  const beginCreate = () => {
    setCreating(true)
    setSlug('')
    setTitle('')
    setBody('')
    setReason('')
  }

  return (
    <FieldSection title="User canon" description="Canon owned by the signed-in operator.">
      {pending ? <p className="text-text-muted">Loading user canon…</p> : null}
      {error ? <ErrorText message={error} /> : null}
      {!pending && !error && rows?.length === 0 ? <p className="text-text-muted">No rows</p> : null}
      {!error ? (
        <div className="grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="space-y-2">
            {rows?.map((row) => (
              <Button
                key={row.slug}
                variant={selected === row.slug && !creating ? 'primary' : 'secondary'}
                onClick={() => {
                  setCreating(false)
                  setChoice(row.slug)
                }}
              >
                {row.slug} · {new TextEncoder().encode(row.body).length} bytes · {row.updated_at}
              </Button>
            ))}
            <Button variant="secondary" onClick={beginCreate}>
              <Plus size={14} /> Create row
            </Button>
          </div>
          {creating || detail.data ? (
            <div className="space-y-3">
              <Input
                aria-label="Slug"
                placeholder="Slug"
                value={slug}
                disabled={!creating}
                onChange={(event) => setSlug(event.target.value)}
              />
              <Input
                aria-label="Title"
                placeholder="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <div className="grid grid-cols-2 divide-x divide-border border border-border-default">
                <Textarea
                  aria-label="Canon markdown"
                  code
                  bare
                  className="h-[32rem]"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
                <div className="h-[32rem] overflow-auto p-3">
                  <Markdown content={body} />
                </div>
              </div>
              <Input
                aria-label="Canon reason"
                placeholder="Reason (required)"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              {save.error ? <ErrorText message={save.error.message} /> : null}
              {remove.error ? <ErrorText message={remove.error.message} /> : null}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={!slug.trim() || !title.trim() || !reason.trim() || save.isPending}
                  onClick={() =>
                    save.mutate({
                      slug,
                      title,
                      body,
                      reason,
                      expectedRevision: creating ? undefined : (detail.data?.revision ?? undefined),
                    })
                  }
                >
                  <Save size={14} /> Save
                </Button>
                <RemoveCanonButton
                  hidden={creating}
                  disabled={!reason.trim() || remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      slug,
                      reason,
                      expectedRevision: detail.data?.revision ?? undefined,
                    })
                  }
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </FieldSection>
  )
}

function AutonomySection({
  project,
  options,
  onProject,
}: {
  project: string
  options: { value: string; label: string }[]
  onProject(value: string): void
}) {
  const autonomy = useQuery({
    ...trpc.context.autonomy.get.queryOptions({ project: project || '_' }),
    enabled: Boolean(project),
  })
  const update = useMutation(
    trpc.context.autonomy.set.mutationOptions({
      onSuccess: (data) =>
        queryClient.setQueryData(
          trpc.context.autonomy.get.queryOptions({ project }).queryKey,
          data,
        ),
    }),
  )
  const updateRelease = useMutation(
    trpc.context.autonomy.setRelease.mutationOptions({
      onSuccess: (data) =>
        queryClient.setQueryData(
          trpc.context.autonomy.get.queryOptions({ project }).queryKey,
          data,
        ),
    }),
  )
  const updatePreset = useMutation(
    trpc.context.autonomy.setPreset.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: trpc.context.autonomy.get.pathKey() }),
    }),
  )
  const refreshed = {
    onSuccess: (data: NonNullable<typeof autonomy.data>) =>
      queryClient.setQueryData(trpc.context.autonomy.get.queryOptions({ project }).queryKey, data),
  }
  const clearStage = useMutation(trpc.context.autonomy.clearStage.mutationOptions(refreshed))
  const setMachine = useMutation(trpc.context.autonomy.setMachine.mutationOptions(refreshed))
  const clearMachine = useMutation(trpc.context.autonomy.clearMachine.mutationOptions(refreshed))
  const machinePending = setMachine.isPending || clearMachine.isPending
  const releaseLine = autonomy.data?.registered
    ? autonomy.data.text.split('\n').find((line) => line.startsWith('release: '))
    : undefined
  const userPreset = autonomy.data?.registered ? autonomy.data.userPreset : undefined
  return (
    <FieldSection
      title="Autonomy"
      description="How much each workflow stage runs on its own, resolved for this machine. Your preset and overrides live in your hosted profile; a row can also be overridden on this machine alone."
    >
      <Select label="Project" value={project} options={options} onChange={onProject} />
      {autonomy.error ? <ErrorText message={autonomy.error.message} /> : null}
      {update.error ? <ErrorText message={update.error.message} /> : null}
      {updateRelease.error ? <ErrorText message={updateRelease.error.message} /> : null}
      {updatePreset.error ? <ErrorText message={updatePreset.error.message} /> : null}
      {clearStage.error ? <ErrorText message={clearStage.error.message} /> : null}
      {setMachine.error ? <ErrorText message={setMachine.error.message} /> : null}
      {clearMachine.error ? <ErrorText message={clearMachine.error.message} /> : null}
      {autonomy.data?.registered
        ? autonomy.data.warnings?.map((warning) => <ErrorText key={warning} message={warning} />)
        : null}
      {autonomy.data?.registered ? (
        <div className="space-y-3">
          <SettingBlock
            label="Preset"
            hint={
              userPreset === undefined
                ? 'Unknown until you sign in.'
                : 'Choosing a preset clears your stage overrides, so every stage follows it.'
            }
            control={
              <Segmented
                label="Autonomy preset"
                value={userPreset ?? ''}
                options={presetOptions}
                onChange={(next) =>
                  updatePreset.mutate({
                    project,
                    value: next as AutonomyPreset,
                  })
                }
              />
            }
          />
          <DisplayRow
            label="Rulings"
            value={
              <span className="flex flex-col gap-1.5">
                <span>{`${autonomy.data.rulings.value} · ${autonomy.data.rulings.scope}`}</span>
                <MachineOverride
                  label="rulings"
                  value={autonomy.data.rulings.machineValue}
                  options={rulingsValues}
                  pending={machinePending}
                  onSet={(next) =>
                    setMachine.mutate({ project, kind: 'rulings', value: next as 'agent' | 'user' })
                  }
                  onRemove={() => clearMachine.mutate({ project, kind: 'rulings' })}
                />
              </span>
            }
          />
          <SettingBlock
            label="release"
            hint={
              <span className="flex flex-col gap-1.5">
                <span>{releaseLine ?? `release: ${autonomy.data.release.value}`}</span>
                <MachineOverride
                  label="release"
                  value={autonomy.data.release.machineValue}
                  options={releaseValues}
                  pending={machinePending}
                  onSet={(next) =>
                    setMachine.mutate({
                      project,
                      kind: 'release',
                      value: next as ReleaseAutonomyValue,
                    })
                  }
                  onRemove={() => clearMachine.mutate({ project, kind: 'release' })}
                />
              </span>
            }
            control={
              <Select
                label="release autonomy"
                value={autonomy.data.release.value}
                options={releaseValues}
                onChange={(next) =>
                  updateRelease.mutate({
                    project,
                    value: next as ReleaseAutonomyValue,
                  })
                }
              />
            }
          />
          {autonomy.data.stages.map((stage) => {
            const value = stage.agreed ? stage.value : (stage.values[0]?.value ?? 'ask')
            const resolved = stage.agreed
              ? `${stage.value} · ${stage.scope}`
              : stage.values
                  .map((item) => `${item.value} (${item.steps} steps, ${item.scope})`)
                  .join('; ')
            return (
              <SettingBlock
                key={stage.stage}
                label={stage.stage}
                hint={
                  <span className="flex flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>Resolved: {resolved}</span>
                      {stage.overridden ? (
                        <>
                          <Badge tone="warning">overridden</Badge>
                          <TextButton
                            disabled={clearStage.isPending}
                            onClick={() => clearStage.mutate({ project, stage: stage.stage })}
                          >
                            Follow preset
                          </TextButton>
                        </>
                      ) : null}
                    </span>
                    <MachineOverride
                      label={stage.stage}
                      value={stage.machineValue}
                      options={stageValues}
                      pending={machinePending}
                      onSet={(next) =>
                        setMachine.mutate({
                          project,
                          kind: 'stage',
                          stage: stage.stage,
                          value: next as AutonomyValue,
                        })
                      }
                      onRemove={() =>
                        clearMachine.mutate({ project, kind: 'stage', stage: stage.stage })
                      }
                    />
                  </span>
                }
                control={
                  <Select
                    label={`${stage.stage} autonomy`}
                    value={value}
                    options={stageValues}
                    onChange={(next) =>
                      update.mutate({
                        project,
                        stage: stage.stage,
                        value: next as AutonomyValue,
                      })
                    }
                  />
                }
              />
            )
          })}
        </div>
      ) : null}
    </FieldSection>
  )
}

/** Your hosted profile's autonomy; every signed-in machine resolves it below its own overrides. */
function HostedAutonomySection({
  project,
  options,
  onProject,
}: {
  project: string
  options: { value: string; label: string }[]
  onProject(value: string): void
}) {
  const api = hostedTrpc.context.autonomy
  const autonomy = useQuery({
    ...api.get.queryOptions({ project: project || '_' }),
    enabled: Boolean(project),
  })
  const refresh = { onSettled: () => queryClient.invalidateQueries({ queryKey: api.pathKey() }) }
  const update = useMutation(api.set.mutationOptions(refresh))
  const updateRelease = useMutation(api.setRelease.mutationOptions(refresh))
  const updatePreset = useMutation(api.setPreset.mutationOptions(refresh))
  const clearStage = useMutation(api.clearStage.mutationOptions(refresh))
  const user = autonomy.data?.user
  const space = autonomy.data?.space
  const error =
    autonomy.error ?? update.error ?? updateRelease.error ?? updatePreset.error ?? clearStage.error
  return (
    <FieldSection
      title="Autonomy"
      description="How much each workflow stage runs on its own. These values are your profile and apply on every machine you sign in from."
    >
      <Select label="Project" value={project} options={options} onChange={onProject} />
      {error ? <ErrorText message={error.message} /> : null}
      {user ? (
        <div className="space-y-3">
          <SettingBlock
            label="Preset"
            hint="Choosing a preset clears your stage overrides, so every stage follows it."
            control={
              <Segmented
                label="Autonomy preset"
                value={user.preset?.value ?? ''}
                options={presetOptions}
                onChange={(next) =>
                  updatePreset.mutate({
                    project,
                    value: next as AutonomyPreset,
                    expectedRowVersion: user.preset?.rowVersion ?? null,
                  })
                }
              />
            }
          />
          <DisplayRow
            label="Rulings"
            value={user.rulings?.value ?? space?.rulings?.value ?? 'not set'}
          />
          <SettingBlock
            label="release"
            hint={user.release ? 'Set in your profile.' : 'Not set; each machine uses its default.'}
            control={
              <Select
                label="release autonomy"
                value={user.release?.value ?? ''}
                options={releaseValues}
                onChange={(next) =>
                  updateRelease.mutate({
                    project,
                    value: next as ReleaseAutonomyValue,
                    expectedRowVersion: user.release?.rowVersion ?? null,
                  })
                }
              />
            }
          />
          {autonomy.data?.stages.map((stage) => {
            const leaf = user.stages[stage]
            return (
              <SettingBlock
                key={stage}
                label={stage}
                hint={
                  leaf ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">overridden</Badge>
                      <TextButton
                        disabled={clearStage.isPending}
                        onClick={() =>
                          clearStage.mutate({
                            project,
                            stage,
                            expectedRowVersion: leaf.rowVersion,
                          })
                        }
                      >
                        Follow preset
                      </TextButton>
                    </span>
                  ) : (
                    `Follows the ${user.preset?.value ?? 'default'} preset`
                  )
                }
                control={
                  <Select
                    label={`${stage} autonomy`}
                    value={leaf?.value ?? ''}
                    options={leaf ? stageValues : [FROM_PRESET, ...stageValues]}
                    onChange={(next) =>
                      update.mutate({
                        project,
                        stage,
                        value: next as AutonomyValue,
                        expectedRowVersion: leaf?.rowVersion ?? null,
                      })
                    }
                  />
                }
              />
            )
          })}
        </div>
      ) : null}
    </FieldSection>
  )
}

type ManagedProject = { name: string; worktreeNote: string | null }

function ManagedSettingsSection({
  target,
  options,
  projects,
  onTarget,
}: {
  target: string
  options: { value: string; label: string }[]
  projects: ManagedProject[]
  onTarget(value: string): void
}) {
  const address = target === 'user' ? ({ user: true } as const) : { project: target }
  const localSettings = useQuery({
    ...trpc.context.settings.get.queryOptions(address),
    enabled: !hosted,
  })
  const hostedSettings = useQuery({
    ...hostedTrpc.context.settings.get.queryOptions(address),
    enabled: hosted,
  })
  const settings = hosted ? hostedSettings : localSettings
  return (
    <FieldSection
      title="Managed settings"
      description={`Stored permissions, hook fingerprints and environment names. ${APPLY_NOTE}`}
    >
      <Select label="Settings target" value={target} options={options} onChange={onTarget} />
      {settings.error ? <ErrorText message={settings.error.message} /> : null}
      {settings.data ? (
        <div className="space-y-5">
          {hosted ? null : (
            <DisplayRow
              label="File"
              value={`${settings.data.file.exists ? 'exists' : 'missing'} · ${settings.data.file.path}`}
            />
          )}
          {(['allow', 'ask', 'deny'] as const).map((name) => (
            <DisplayRow
              key={name}
              label={`${name} (${settings.data.settings.permissions[name].length})`}
              value={<Lines>{settings.data.settings.permissions[name].join('\n') || '—'}</Lines>}
            />
          ))}
          <DisplayRow
            label={`Hooks (${settings.data.settings.hooks.length})`}
            value={
              <Lines>
                {settings.data.settings.hooks
                  .map((hook) => `${hook.event} · ${hook.matcher} · ${hook.fingerprint}`)
                  .join('\n') || '—'}
              </Lines>
            }
          />
          <DisplayRow
            label={`Environment keys (${settings.data.settings.envKeys.length})`}
            value={settings.data.settings.envKeys.join(', ') || '—'}
          />
          {settings.data.drift ? (
            <DisplayRow label="Drift" value={<Lines>{driftText(settings.data.drift)}</Lines>} />
          ) : null}
          {settings.data.findings?.map((finding) => (
            <ErrorText
              key={`${finding.rule}-${finding.message}`}
              message={`${finding.rule}: ${finding.message}`}
            />
          ))}
          <PermissionEditor address={address} revision={settings.data.revision} />
          <MachinePermissionOverlay machine={userMachineOverlay(target, localSettings.data)} />
          {hosted ? null : (
            <SettingBlock
              label="Apply now from a terminal"
              control={<Copyable value={applyCommand(target, projects)} />}
              hint="This page stores the settings; the machine writes its settings file when it applies them."
            />
          )}
        </div>
      ) : null}
    </FieldSection>
  )
}

/** The machine overlay is user-level, so a project target has none to show. */
function userMachineOverlay<Machine>(target: string, data: { machine?: Machine } | undefined) {
  return target === 'user' ? data?.machine : undefined
}

function applyCommand(target: string, projects: ManagedProject[]) {
  if (target === 'user') return 'orch settings render --write --user --yes'
  const note = projects.find((row) => row.name === target)?.worktreeNote
  const command = `orch settings render --write --project ${target} --yes`
  return note ? `${command}\n\nWorktree note:\n${note}` : command
}

function PermissionEditor({
  address,
  revision,
}: {
  address: { user: true } | { project: string }
  revision: string | null
}) {
  const [list, setList] = useState<'allow' | 'ask' | 'deny'>('allow')
  const [rule, setRule] = useState('')
  const [reason, setReason] = useState('')
  const settingsKey = hosted
    ? hostedTrpc.context.settings.pathKey()
    : trpc.context.settings.pathKey()
  const changed = async () => {
    setRule('')
    setReason('')
    await queryClient.invalidateQueries({ queryKey: settingsKey })
  }
  const localChange = useMutation(
    trpc.context.settings.permission.mutationOptions({ onSuccess: changed }),
  )
  const hostedChange = useMutation(
    hostedTrpc.context.settings.permission.mutationOptions({ onSuccess: changed }),
  )
  const change = hosted ? hostedChange : localChange
  return (
    <>
      <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
        <Select
          label="Permission list"
          value={list}
          options={[
            { value: 'allow', label: 'Allow' },
            { value: 'ask', label: 'Ask' },
            { value: 'deny', label: 'Deny' },
          ]}
          onChange={(value) => setList(value as typeof list)}
        />
        <Input
          aria-label="Permission rule"
          placeholder="Permission rule"
          value={rule}
          onChange={(event) => setRule(event.target.value)}
        />
      </div>
      <Input
        aria-label="Settings reason"
        placeholder="Reason (required)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {change.error ? <ErrorText message={change.error.message} /> : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!revision || !rule.trim() || !reason.trim() || change.isPending}
          onClick={() =>
            change.mutate({
              target: address,
              list,
              rule,
              operation: 'add',
              reason,
              expectedRevision: revision ?? '',
            })
          }
        >
          Add rule
        </Button>
        <Button
          variant="danger"
          disabled={!revision || !rule.trim() || !reason.trim() || change.isPending}
          onClick={() =>
            change.mutate({
              target: address,
              list,
              rule,
              operation: 'remove',
              reason,
              expectedRevision: revision ?? '',
            })
          }
        >
          Remove rule
        </Button>
      </div>
    </>
  )
}

function driftText(drift: {
  rules: Record<'allow' | 'ask' | 'deny', { added: string[]; removed: string[] }>
  hooks: {
    added: { event: string; matcher: string; fingerprint: string }[]
    removed: { event: string; matcher: string; fingerprint: string }[]
  }
  envKeys: { added: string[]; removed: string[] }
}) {
  const lines: string[] = []
  for (const name of ['allow', 'ask', 'deny'] as const) {
    lines.push(...drift.rules[name].added.map((rule) => `added ${name}: ${rule}`))
    lines.push(...drift.rules[name].removed.map((rule) => `removed ${name}: ${rule}`))
  }
  lines.push(
    ...drift.hooks.added.map(
      (hook) => `added hook: ${hook.event} · ${hook.matcher} · ${hook.fingerprint}`,
    ),
  )
  lines.push(
    ...drift.hooks.removed.map(
      (hook) => `removed hook: ${hook.event} · ${hook.matcher} · ${hook.fingerprint}`,
    ),
  )
  lines.push(...drift.envKeys.added.map((name) => `added env key: ${name}`))
  lines.push(...drift.envKeys.removed.map((name) => `removed env key: ${name}`))
  return lines.join('\n') || 'No drift'
}
