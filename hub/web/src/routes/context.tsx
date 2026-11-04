import { hostedTrpc, queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { useMachinePermissionChange } from '@bottega/hub-data/use-machine-permission'
import { Badge } from '@bottega/hub-ui/badge'
import { Button, TextButton } from '@bottega/hub-ui/button'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Textarea } from '@bottega/hub-ui/field/textarea'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from '@bottega/hub-ui/form-layout'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { Segmented } from '@bottega/hub-ui/segmented'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { permissionListLabel } from '@bottega/hub-util/format'
import { MachineOverride } from '@bottega/hub-views/machine-permissions/machine-override'
import { MachinePermissionEditor } from '@bottega/hub-views/machine-permissions/machine-permission-editor'
import { Markdown } from '@bottega/hub-views/markdown'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, Save, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_VALUES,
  type AutonomyPreset,
  type AutonomyValue,
} from '../../../../shared/autonomy'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import { isShipToValue, SHIP_TO_VALUES } from '../../../../shared/ship-to'

export const Route = createFileRoute('/context')({ component: ManagedContextPage })

/**
 * The local and hosted servers mount different routers, so every read and write names the
 * proxy for its mode and the page uses only fields both shapes carry.
 */
const hosted = isHostedMode()

const capitalized = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1)}`

const presetOptions = AUTONOMY_PRESETS.map((value) => ({ value, label: capitalized(value) }))

const stageValues = AUTONOMY_VALUES.map((value) => ({ value, label: capitalized(value) }))

const FROM_PRESET = { value: '', label: 'From preset', disabled: true }

const shipToValues = SHIP_TO_VALUES.map((value) => ({ value, label: capitalized(value) }))

const rulingsValues = (['agent', 'user'] as const).map((value) => ({
  value,
  label: capitalized(value),
}))

function ErrorText({
  message,
  title = 'Could not update agent settings',
}: {
  message: string
  title?: string
}) {
  return <ErrorState title={title} message={message} />
}

function LoadError({ title, error }: { title: string; error: { message: string } | null }) {
  return error ? <ErrorState title={`Could not load ${title}`} message={error.message} /> : null
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

function InstructionsEditor({ body, onChange }: { body: string; onChange(value: string): void }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-border border border-border-default">
      <Textarea
        aria-label="Instructions"
        code
        bare
        className="h-[32rem]"
        value={body}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="h-[32rem] overflow-auto p-3">
        <Markdown content={body} />
      </div>
    </div>
  )
}

function ShipToSetting({
  detail,
  value,
  onChange,
}: {
  detail: ReactNode
  value: string
  onChange(value: string): void
}) {
  return (
    <SettingBlock
      label="Ship to"
      hint={detail}
      control={
        <Select
          label="Ship to"
          hint="Chooses where completed work is sent, for every project."
          value={value}
          options={shipToValues}
          onChange={onChange}
        />
      }
    />
  )
}

export function ManagedContextPage() {
  const phone = useMediaQuery(PHONE_QUERY)
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
    { value: 'user', label: 'Your account' },
    ...managedProjects.map((project) => ({ value: project.name, label: project.name })),
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-5 pb-12">
      <PageHeader
        title="Agent settings"
        subtitle="These settings belong to your account and follow you to every machine you sign in on. A row marked as overridden applies on this machine only."
        actions={
          phone ? (
            <ToolbarBand
              filters={
                <>
                  <Select
                    label="Project"
                    hint="Chooses the project whose autonomy values are shown."
                    value={selectedProject}
                    options={projectOptions}
                    onChange={setProjectChoice}
                  />
                  <Select
                    label="Settings target"
                    hint="Chooses whether the shown permissions belong to your account or a project."
                    value={settingsChoice}
                    options={settingsOptions}
                    onChange={setSettingsChoice}
                  />
                </>
              }
            />
          ) : undefined
        }
      />
      {hosted ? (
        <HostedAutonomySection
          project={selectedProject}
          options={projectOptions}
          onProject={setProjectChoice}
          showChooser={!phone}
        />
      ) : (
        <AutonomySection
          project={selectedProject}
          options={projectOptions}
          onProject={setProjectChoice}
          showChooser={!phone}
        />
      )}
      <UserCanonSection rows={canon.data} pending={canon.isPending} error={canon.error?.message} />
      <ManagedSettingsSection
        target={settingsChoice}
        options={settingsOptions}
        projects={managedProjects}
        onTarget={setSettingsChoice}
        showChooser={!phone}
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
    <FieldSection
      title="Your instructions"
      description="Added to every agent's instructions in every project, ahead of the project's own."
    >
      {pending ? <EmptyState title="Loading your instructions..." /> : null}
      {error ? <ErrorState title="Could not load your instructions" message={error} /> : null}
      {!pending && !error && rows?.length === 0 ? (
        <EmptyState title="No instructions yet." />
      ) : null}
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
              <Plus size={14} /> Create instructions
            </Button>
          </div>
          {creating || detail.data ? (
            <div className="space-y-3">
              <Input
                aria-label="Name"
                placeholder="Name"
                hint="Names this set of instructions and cannot change after it is created."
                value={slug}
                disabled={!creating}
                onChange={(event) => setSlug(event.target.value)}
              />
              <Input
                aria-label="Title"
                placeholder="Title"
                hint="Gives this set of instructions a readable title."
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <InstructionsEditor body={body} onChange={setBody} />
              <Input
                aria-label="Change reason"
                placeholder="Reason (required)"
                hint="Records why these instructions are changing."
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

type AutonomySectionProps = {
  project: string
  options: { value: string; label: string }[]
  onProject(value: string): void
  showChooser: boolean
}

function ProjectChooser(props: AutonomySectionProps) {
  return props.showChooser ? (
    <Select
      label="Project"
      hint="Chooses the project whose autonomy values are shown."
      value={props.project}
      options={props.options}
      onChange={props.onProject}
    />
  ) : null
}

function AutonomySection({ project, options, onProject, showChooser }: AutonomySectionProps) {
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
  const updateShipTo = useMutation(
    trpc.context.autonomy.setShipTo.mutationOptions({
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
  const shipToLine = autonomy.data?.registered
    ? autonomy.data.text.split('\n').find((line) => line.startsWith('ship to: '))
    : undefined
  const userPreset = autonomy.data?.registered ? autonomy.data.userPreset : undefined
  return (
    <FieldSection
      title="Autonomy"
      description="Values resolve for the selected project. An Overridden badge means the value applies on this machine only."
    >
      <ProjectChooser {...{ project, options, onProject, showChooser }} />
      <LoadError title="autonomy settings" error={autonomy.error} />
      {update.error ? <ErrorText message={update.error.message} /> : null}
      {updateShipTo.error ? <ErrorText message={updateShipTo.error.message} /> : null}
      {updatePreset.error ? <ErrorText message={updatePreset.error.message} /> : null}
      {clearStage.error ? <ErrorText message={clearStage.error.message} /> : null}
      {setMachine.error ? <ErrorText message={setMachine.error.message} /> : null}
      {clearMachine.error ? <ErrorText message={clearMachine.error.message} /> : null}
      {autonomy.data?.registered
        ? autonomy.data.warnings?.map((warning) => (
            <ErrorText key={warning} title="Check this setting" message={warning} />
          ))
        : null}
      {autonomy.data?.registered ? (
        <div className="space-y-3">
          <SettingBlock
            label="Preset"
            hint={
              userPreset === undefined
                ? 'Available after you sign in.'
                : 'Sets the default independence for every workflow stage and clears stage-specific choices. A stricter preset applies to workflows already running; a looser one applies only to workflows started afterwards.'
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
                  label="Rulings"
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
          <ShipToSetting
            detail={
              <span className="flex flex-col gap-1.5">
                <span>{shipToLine ?? `ship to: ${autonomy.data.shipTo.value}`}</span>
                <MachineOverride
                  label="Ship to"
                  value={autonomy.data.shipTo.machineValue}
                  options={shipToValues}
                  pending={machinePending}
                  onSet={(next) => {
                    if (isShipToValue(next)) {
                      setMachine.mutate({ project, kind: 'shipTo', value: next })
                    }
                  }}
                  onRemove={() => clearMachine.mutate({ project, kind: 'shipTo' })}
                />
              </span>
            }
            value={autonomy.data.shipTo.value}
            onChange={(next) => {
              if (isShipToValue(next)) updateShipTo.mutate({ project, value: next })
            }}
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
                label={capitalized(stage.stage)}
                hint={
                  <span className="flex flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>Resolved: {resolved}</span>
                      {stage.overridden ? (
                        <>
                          <Badge tone="warning">Custom</Badge>
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
                      label={capitalized(stage.stage)}
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
                    label={`${capitalized(stage.stage)} autonomy`}
                    hint={`Sets how independently agents run the ${capitalized(stage.stage)} stage for this project.`}
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
function HostedAutonomySection({ project, options, onProject, showChooser }: AutonomySectionProps) {
  const api = hostedTrpc.context.autonomy
  const autonomy = useQuery({
    ...api.get.queryOptions({ project: project || '_' }),
    enabled: Boolean(project),
  })
  const refresh = { onSettled: () => queryClient.invalidateQueries({ queryKey: api.pathKey() }) }
  const update = useMutation(api.set.mutationOptions(refresh))
  const updateShipTo = useMutation(api.setShipTo.mutationOptions(refresh))
  const updatePreset = useMutation(api.setPreset.mutationOptions(refresh))
  const clearStage = useMutation(api.clearStage.mutationOptions(refresh))
  const user = autonomy.data?.user
  const space = autonomy.data?.space
  const mutationError = update.error ?? updateShipTo.error ?? updatePreset.error ?? clearStage.error
  return (
    <FieldSection
      title="Autonomy"
      description="Values resolve for the selected project. An Overridden badge means the value applies on one machine only."
    >
      <ProjectChooser {...{ project, options, onProject, showChooser }} />
      <LoadError title="autonomy settings" error={autonomy.error} />
      {mutationError ? <ErrorText message={mutationError.message} /> : null}
      {user ? (
        <div className="space-y-3">
          <SettingBlock
            label="Preset"
            hint="Sets the default independence for every workflow stage and clears stage-specific choices. A stricter preset applies to workflows already running; a looser one applies only to workflows started afterwards."
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
          <ShipToSetting
            detail={
              user.shipTo ? 'Set in your profile.' : 'Not set; each machine uses its default.'
            }
            value={user.shipTo?.value ?? ''}
            onChange={(next) => {
              if (isShipToValue(next)) {
                updateShipTo.mutate({
                  project,
                  value: next,
                  expectedRowVersion: user.shipTo?.rowVersion ?? null,
                })
              }
            }}
          />
          {autonomy.data?.stages.map((stage) => {
            const leaf = user.stages[stage]
            return (
              <SettingBlock
                key={stage}
                label={capitalized(stage)}
                hint={
                  leaf ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">Custom</Badge>
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
                    label={`${capitalized(stage)} autonomy`}
                    hint={`Sets how independently agents run the ${capitalized(stage)} stage for this project.`}
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
  showChooser,
}: {
  target: string
  options: { value: string; label: string }[]
  projects: ManagedProject[]
  onTarget(value: string): void
  showChooser: boolean
}) {
  const machinePermissionChange = useMachinePermissionChange()
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
      title="Agent permissions"
      description="What agents may run without asking. Applied to each harness on your machines when a session starts."
    >
      {showChooser ? (
        <Select
          label="Settings target"
          hint="Chooses whether the shown permissions belong to your account or a project."
          value={target}
          options={options}
          onChange={onTarget}
        />
      ) : null}
      <LoadError title="managed settings" error={settings.error} />
      {settings.data ? (
        <div className="space-y-5">
          {hosted ? null : (
            <DisplayRow
              label="Available on this machine"
              value={settings.data.file.exists ? 'Yes' : 'Not yet'}
            />
          )}
          {(['allow', 'ask', 'deny'] as const).map((name) => (
            <DisplayRow
              key={name}
              label={`${permissionListLabel(name)} (${settings.data.settings.permissions[name].length})`}
              value={<Lines>{settings.data.settings.permissions[name].join('\n') || '—'}</Lines>}
            />
          ))}
          <DisplayRow
            label={`Hooks (${settings.data.settings.hooks.length})`}
            value={
              <span className="flex flex-col gap-1.5">
                <span className="text-sm text-text-muted">
                  A hook runs an automatic check or action when an agent reaches a matching event.
                </span>
                <Lines>
                  {settings.data.settings.hooks
                    .map((hook) => `${hook.event} · ${hook.matcher} · ${hook.fingerprint}`)
                    .join('\n') || '—'}
                </Lines>
              </span>
            }
          />
          <DisplayRow
            label={`Environment keys (${settings.data.settings.envKeys.length})`}
            value={settings.data.settings.envKeys.join(', ') || '—'}
          />
          {settings.data.drift ? (
            <DisplayRow
              label="Differs on this machine"
              value={<Lines>{driftText(settings.data.drift)}</Lines>}
            />
          ) : null}
          {settings.data.findings?.map((finding) => (
            <ErrorText
              key={`${finding.rule}-${finding.message}`}
              title="Check these permissions"
              message={`${finding.rule}: ${finding.message}`}
            />
          ))}
          <PermissionEditor address={address} revision={settings.data.revision} />
          <MachinePermissionEditor
            machine={userMachineOverlay(target, localSettings.data)}
            change={machinePermissionChange}
          />
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
  if (target === 'user') return `${PLATFORM_SLUG} machine settings render --write --user --yes`
  const note = projects.find((row) => row.name === target)?.worktreeNote
  const command = `${PLATFORM_SLUG} machine settings render --write --project ${target} --yes`
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
          hint="Chooses whether the rule is allowed, asks first, or is blocked."
          value={list}
          options={[
            { value: 'allow', label: permissionListLabel('allow') },
            { value: 'ask', label: permissionListLabel('ask') },
            { value: 'deny', label: permissionListLabel('deny') },
          ]}
          onChange={(value) => setList(value as typeof list)}
        />
        <Input
          aria-label="Permission rule"
          placeholder="Permission rule"
          hint="Names the command or action this permission matches."
          value={rule}
          onChange={(event) => setRule(event.target.value)}
        />
      </div>
      <Input
        aria-label="Change reason"
        placeholder="Reason (required)"
        hint="Records why this permission is changing."
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
    lines.push(
      ...drift.rules[name].added.map((rule) => `Added to ${permissionListLabel(name)}: ${rule}`),
    )
    lines.push(
      ...drift.rules[name].removed.map(
        (rule) => `Removed from ${permissionListLabel(name)}: ${rule}`,
      ),
    )
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
