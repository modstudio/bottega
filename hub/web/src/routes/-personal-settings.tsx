import { hostedTrpc, queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Badge } from '@bottega/hub-ui/badge'
import { TextButton } from '@bottega/hub-ui/button'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { DisplayRow, FieldSection, SettingBlock } from '@bottega/hub-ui/form-layout'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { Segmented } from '@bottega/hub-ui/segmented'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import {
  type AutonomyChoice,
  type AutonomyColumn,
  type AutonomyEdit,
  type AutonomyLayer,
  AutonomyLayers,
} from '@bottega/hub-views/machine-permissions/autonomy-layers'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { type ReactNode, useState } from 'react'
import {
  AUTONOMY_PRESETS,
  AUTONOMY_STAGES,
  AUTONOMY_VALUES,
  type AutonomyPreset,
  type AutonomyValue,
} from '../../../../shared/autonomy'
import { isShipToValue, SHIP_TO_VALUES } from '../../../../shared/ship-to'
import type { AppRouter } from '../../../src/trpc/router.ts'

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

/** Personal settings span every agent on every machine you sign in on. */
const PERSONAL_SUBTITLE =
  'Your setup for every agent, on every machine you sign in on. A row marked as overridden applies on this machine only.'

function PersonalFrame({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-[96rem] space-y-8 px-5 pb-12">
      <PageHeader title={title} subtitle={PERSONAL_SUBTITLE} actions={actions} />
      {children}
    </div>
  )
}

function useProjects() {
  const localProjects = useQuery({ ...trpc.context.projects.queryOptions(), enabled: !hosted })
  const hostedProjects = useQuery({
    ...hostedTrpc.context.projects.queryOptions(),
    enabled: hosted,
  })
  return hosted ? hostedProjects : localProjects
}

export function PersonalAutonomyPage() {
  const phone = useMediaQuery(PHONE_QUERY)
  const projects = useProjects()
  const [projectChoice, setProjectChoice] = useState('')
  const selectedProject = projectChoice || projects.data?.[0]?.name || ''
  const projectOptions = (projects.data ?? []).map((project) => ({
    value: project.name,
    label: project.name,
  }))
  const section = { project: selectedProject, options: projectOptions, onProject: setProjectChoice }
  return (
    <PersonalFrame
      title="Autonomy"
      actions={
        phone ? (
          <ToolbarBand
            filters={
              <Select
                label="Project"
                hint="Chooses the project whose autonomy values are shown."
                value={selectedProject}
                options={projectOptions}
                onChange={setProjectChoice}
              />
            }
          />
        ) : undefined
      }
    >
      {hosted ? (
        <HostedAutonomySection {...section} showChooser={!phone} />
      ) : (
        <AutonomySection {...section} showChooser={!phone} />
      )}
    </PersonalFrame>
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

type LocalAutonomy = inferRouterOutputs<AppRouter>['context']['autonomy']['get']
type RegisteredAutonomy = Extract<LocalAutonomy, { registered: true }>
type ResolvedLayer = NonNullable<RegisteredAutonomy['layers']>[number]

const STALE = ' (stale)'

/** What each resolution scope is called on this page, in the order the resolver consults them. */
const LAYER_TEXT: Record<string, { label: string; hint: string }> = {
  session: { label: 'This session', hint: 'Set by the session asking.' },
  'local project': {
    label: 'This machine, this project',
    hint: "This machine's config for this project only.",
  },
  project: { label: 'Project settings', hint: "The project's own settings." },
  'local user': { label: 'This machine', hint: 'Every project on this machine.' },
  'hosted user': { label: 'Your account', hint: 'Every machine you sign in on.' },
  'hosted space': { label: 'Space', hint: 'Everyone in the space.' },
  'built-in': { label: 'Built-in', hint: 'When no layer above says anything.' },
}

const AUTONOMY_COLUMNS: AutonomyColumn[] = [
  { id: 'preset', label: 'Preset' },
  { id: 'rulings', label: 'Rulings' },
  { id: 'shipTo', label: 'Ship to' },
  ...AUTONOMY_STAGES.map((stage) => ({ id: stage, label: capitalized(stage) })),
]

function layerValues(layer: ResolvedLayer): Record<string, string | null> {
  return { preset: layer.preset, rulings: layer.rulings, shipTo: layer.shipTo, ...layer.stages }
}

const NOT_SET = { label: 'Not set' }
const KEEP = { label: 'Not set', disabled: true }

function machineChoices(layer: ResolvedLayer): Record<string, AutonomyChoice> {
  return {
    rulings: { options: rulingsValues, selected: layer.rulings, unset: NOT_SET },
    shipTo: { options: shipToValues, selected: layer.shipTo, unset: NOT_SET },
    ...Object.fromEntries(
      AUTONOMY_STAGES.map((stage) => [
        stage,
        { options: stageValues, selected: layer.stages[stage], unset: NOT_SET },
      ]),
    ),
  }
}

function accountChoices(
  layer: ResolvedLayer,
  data: RegisteredAutonomy,
): Record<string, AutonomyChoice> {
  return {
    preset: { options: presetOptions, selected: data.userPreset ?? null, unset: KEEP },
    shipTo: { options: shipToValues, selected: layer.shipTo, unset: KEEP },
    ...Object.fromEntries(
      data.stages.map((stage) => {
        const own = stage.overridden ? layer.stages[stage.stage] : null
        const followed = own === null ? layer.stages[stage.stage] : null
        return [
          stage.stage,
          {
            options: stageValues,
            selected: own,
            unset: { label: followed ? `Preset (${followed})` : 'From preset' },
          },
        ]
      }),
    ),
  }
}

/**
 * The page's rows: every scope the resolver consulted, in its order, labeled for a person.
 * The session layer is hidden when it says nothing, since the hub never runs in a session.
 * This machine is editable here; your account is editable once you have signed in.
 */
export function autonomyLayers(data: RegisteredAutonomy): AutonomyLayer[] {
  return (data.layers ?? [])
    .filter((layer) => layer.scope !== 'session' || Object.values(layerValues(layer)).some(Boolean))
    .map((layer) => {
      const stale = layer.scope.endsWith(STALE)
      const base = stale ? layer.scope.slice(0, -STALE.length) : layer.scope
      const text = LAYER_TEXT[base] ?? { label: base, hint: '' }
      const editable =
        base === 'local user'
          ? machineChoices(layer)
          : base === 'hosted user' && !stale && data.userPreset !== undefined
            ? accountChoices(layer, data)
            : undefined
      return {
        scope: layer.scope,
        label: text.label,
        hint: stale
          ? `${text.hint} Read from the cache; your account could not be reached.`
          : text.hint,
        values: layerValues(layer),
        ...(editable ? { editable } : {}),
      }
    })
}

function useAutonomyMutations() {
  const api = trpc.context.autonomy
  const refreshed = {
    onSettled: () => queryClient.invalidateQueries({ queryKey: api.get.pathKey() }),
  }
  return {
    set: useMutation(api.set.mutationOptions(refreshed)),
    setShipTo: useMutation(api.setShipTo.mutationOptions(refreshed)),
    setPreset: useMutation(api.setPreset.mutationOptions(refreshed)),
    clearStage: useMutation(api.clearStage.mutationOptions(refreshed)),
    setMachine: useMutation(api.setMachine.mutationOptions(refreshed)),
    clearMachine: useMutation(api.clearMachine.mutationOptions(refreshed)),
  }
}

type AutonomyMutations = ReturnType<typeof useAutonomyMutations>

const stageOf = (column: string) => AUTONOMY_STAGES.find((stage) => stage === column)

/** This machine's row writes machine config: a choice sets the key, "Not set" deletes it. */
function writeMachine(
  mutations: AutonomyMutations,
  project: string,
  column: string,
  value: string | null,
) {
  const stage = stageOf(column)
  if (column === 'rulings') {
    if (value === null) mutations.clearMachine.mutate({ project, kind: 'rulings' })
    else if (value === 'agent' || value === 'user')
      mutations.setMachine.mutate({ project, kind: 'rulings', value })
  } else if (column === 'shipTo') {
    if (value === null) mutations.clearMachine.mutate({ project, kind: 'shipTo' })
    else if (isShipToValue(value)) mutations.setMachine.mutate({ project, kind: 'shipTo', value })
  } else if (stage) {
    if (value === null) mutations.clearMachine.mutate({ project, kind: 'stage', stage })
    else
      mutations.setMachine.mutate({ project, kind: 'stage', stage, value: value as AutonomyValue })
  }
}

/** Your account's row writes your hosted profile; "From preset" clears a stage choice. */
function writeAccount(
  mutations: AutonomyMutations,
  project: string,
  column: string,
  value: string | null,
) {
  const stage = stageOf(column)
  if (column === 'preset' && value)
    mutations.setPreset.mutate({ project, value: value as AutonomyPreset })
  else if (column === 'shipTo' && value && isShipToValue(value))
    mutations.setShipTo.mutate({ project, value })
  else if (stage && value === null) mutations.clearStage.mutate({ project, stage })
  else if (stage && value) mutations.set.mutate({ project, stage, value: value as AutonomyValue })
}

/** Routes a table edit to the write for its layer: this machine's config, or your account. */
function useAutonomyEdit(project: string): AutonomyEdit {
  const mutations = useAutonomyMutations()
  const all = Object.values(mutations)
  const pending = all.some((mutation) => mutation.isPending)
  return {
    pending,
    error: all.find((mutation) => mutation.error)?.error?.message ?? null,
    run(scope, column, value) {
      if (pending) return
      if (scope === 'local user') writeMachine(mutations, project, column, value)
      else if (scope === 'hosted user') writeAccount(mutations, project, column, value)
    },
  }
}

function AutonomySection({ project, options, onProject, showChooser }: AutonomySectionProps) {
  const autonomy = useQuery({
    ...trpc.context.autonomy.get.queryOptions({ project: project || '_' }),
    enabled: Boolean(project),
  })
  const edit = useAutonomyEdit(project)
  const data = autonomy.data?.registered ? autonomy.data : null
  return (
    <FieldSection
      title="Where each setting comes from"
      description="Agents consult these layers from the top down and use the first one that says something; that cell is marked. Changing your account's preset clears its stage choices. A stricter preset applies to workflows already running; a looser one applies only to workflows started afterwards."
    >
      <ProjectChooser {...{ project, options, onProject, showChooser }} />
      <LoadError title="autonomy settings" error={autonomy.error} />
      {autonomy.isLoading ? <EmptyState title="Loading autonomy..." /> : null}
      {data?.warnings?.map((warning) => (
        <ErrorText key={warning} title="Check this setting" message={warning} />
      ))}
      {data && !data.layers ? (
        <ErrorText
          title="Layers unavailable"
          message="The installed CLI does not report autonomy layers; update it and reload."
        />
      ) : null}
      {data?.layers ? (
        <AutonomyLayers layers={autonomyLayers(data)} columns={AUTONOMY_COLUMNS} edit={edit} />
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
