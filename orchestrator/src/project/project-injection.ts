// concern: project-injection
/** Knows the project facts shared workflows may request, their stored grammar, and refusal remedies. */
import { z } from 'zod'
import {
  refuseHubActionOverrides,
  refuseInvalidReviewStages,
  refuseNonCursorProjectId,
  resolveTrackerAgentActions,
  TRACKER_PROTOCOLS,
  type TrackerAction,
  type TrackerProtocol,
  type TrackerSettings,
  trackerSettingsShape,
} from '../../../shared/trackers.ts'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) => z.strictObject(shape)

const releaseSchema = strictObject({
  rungs: z.array(
    strictObject({
      name: z.string(),
      branch: z.string(),
      deploy: z.string().optional(),
      live: z.string().trim().min(1).optional(),
    }),
  ),
  mergeMethod: z.enum(['squash', 'merge', 'rebase']),
  requiredChecks: z.array(z.string()),
  observationWindowHours: z.number().int().positive().optional(),
})

const docsSchema = z.discriminatedUnion('protocol', [
  strictObject({ protocol: z.literal('orch-docs') }),
  strictObject({ protocol: z.literal('workspace-mcp') }),
  strictObject({ protocol: z.literal('cursor-mcp') }),
  strictObject({ protocol: z.literal('array-mcp') }),
])

const gateSchema = z.string().trim().min(1)
const trunkSchema = z.string().trim().min(1)
// The shared shape keeps protocol open so hub can read any stored row; the
// register edge accepts only protocols a workflow can act on.
const trackerSchema = strictObject({
  ...trackerSettingsShape,
  protocol: z.enum(TRACKER_PROTOCOLS),
}).superRefine((tracker, context) => {
  refuseHubActionOverrides(tracker, context)
  refuseNonCursorProjectId(tracker, context)
  refuseInvalidReviewStages(tracker, context)
})

export type ReleaseSettings = z.infer<typeof releaseSchema>
export type DocsSettings = z.infer<typeof docsSchema>
type ResolvedDocs = DocsSettings & {
  server?: string
  read: string[]
  write: string[]
}
type ResolvedTracker = {
  kind: string
  protocol: TrackerProtocol
  server?: string
  actions: Partial<Record<TrackerAction, string>>
  states: Partial<Record<'active' | 'review' | 'done', string>>
  waitingReview: { state: string; floor: 'tracker-transition' | 'recorded-artifact' }
  inReview: { state: string; floor: 'tracker-transition' | 'recorded-artifact' }
}

const docsAdapters: Record<DocsSettings['protocol'], { read: string[]; write: string[] }> = {
  'workspace-mcp': {
    read: ['search-articles-tool', 'get-article-tool', 'list-rules-tool', 'get-rule-tool'],
    write: ['create-article-tool', 'update-article-tool', 'update-rule-tool'],
  },
  'cursor-mcp': {
    read: ['document_list', 'document_get', 'document_getByKey'],
    write: ['document_create', 'document_update'],
  },
  'array-mcp': {
    read: ['doc_search', 'doc_get', 'doc_list'],
    write: ['doc_create', 'doc_update'],
  },
  'orch-docs': { read: ['list_docs', 'get_doc'], write: ['set_doc'] },
}

const trackerProtocols = new Set<string>(TRACKER_PROTOCOLS)
// Substituted values reach a command an agent runs, so they carry no shell
// syntax and cannot open with a dash that the command would read as a flag.
const projectNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const taskKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function trackerProtocol(value: string | undefined): TrackerProtocol {
  if (!value || !trackerProtocols.has(value)) {
    throw new Error(
      `tracker protocol ${value ?? '(missing)'} has no workflow injection support; set tracker.protocol to one of ${TRACKER_PROTOCOLS.join(', ')}`,
    )
  }
  return value as TrackerProtocol
}

function substituteAction(template: string, project: string, key: string | undefined): string {
  return template
    .replaceAll('{project}', projectNamePattern.test(project) ? project : '{project}')
    .replaceAll('{key}', key && taskKeyPattern.test(key) ? key : '{key}')
}

export function unresolvedTrackerActionPlaceholder(
  action: string,
  project: string,
  key: string | undefined,
): string | null {
  if (action.includes('{project}'))
    return `project value "${project}" does not match project-name grammar`
  if (action.includes('{key}'))
    return `task-key value "${key ?? '(missing)'}" does not match task-key grammar`
  return null
}

function resolvedReviewStages(projectName: string, tracker: TrackerSettings, protocol: TrackerProtocol) {
  const reviewStates = Object.entries(tracker.states ?? {}).flatMap(([raw, category]) =>
    category === 'review' ? [raw] : [],
  )
  if (protocol === 'hub' && reviewStates.length === 0) reviewStates.push('review')
  if (!tracker.reviewStages && reviewStates.length > 1) {
    throw new Error(
      `project ${projectName} tracker has several review states (${reviewStates.join(', ')}) but no reviewStages selection; set it with: orch project set ${projectName} --settings '${JSON.stringify({ tracker: { reviewStages: { waiting: '<waiting-review-state>', active: '<in-review-state>' } } })}'`,
    )
  }
  const waiting = tracker.reviewStages?.waiting ?? reviewStates[0]
  const active = tracker.reviewStages?.active ?? reviewStates[0]
  const stage = (state: string | undefined) =>
    state
      ? ({ state, floor: 'tracker-transition' } as const)
      : ({ state: 'none', floor: 'recorded-artifact' } as const)
  return { waitingReview: stage(waiting), inReview: stage(active) }
}

type InjectionSettings = {
  tracker?: TrackerSettings
  trunk?: string
  gate?: string
  worktree?: unknown
  release?: ReleaseSettings
  docs?: DocsSettings
  mainStack?: { consumers: string[]; requiredServices?: string[] }
}

type InjectableProject = {
  name: string
  stack: string | null
  settings: InjectionSettings
}

const injectionSources = [
  'tracker',
  'trunk',
  'gate',
  'worktree',
  'release',
  'docs',
  'stack',
  'mainStack',
] as const
export type InjectionSource = (typeof injectionSources)[number]
export const workflowFactSources = [...injectionSources, 'ship-to', 'workflow-text'] as const
export type WorkflowFactSource = (typeof workflowFactSources)[number]

type InjectionValues<Project extends InjectableProject> = {
  tracker: ResolvedTracker
  trunk: NonNullable<Project['settings']['trunk']>
  gate: NonNullable<Project['settings']['gate']>
  worktree: NonNullable<Project['settings']['worktree']>
  release: NonNullable<Project['settings']['release']>
  docs: ResolvedDocs
  stack: NonNullable<Project['stack']>
  mainStack: { requiredServices: string[]; requiredServicesText: string }
}

type ResolvedInjection<
  Project extends InjectableProject,
  Needs extends readonly InjectionSource[],
> = Pick<InjectionValues<Project>, Needs[number]>

const settingCommands: Record<Exclude<InjectionSource, 'stack'>, string> = {
  tracker: `--settings '{"tracker":{"protocol":"<protocol>"}}'`,
  trunk: `--settings '{"trunk":"<branch>"}'`,
  gate: `--settings '{"gate":"<command>"}'`,
  worktree: `--settings '{"worktree":{}}'`,
  release: `--settings '{"release":{"rungs":[],"mergeMethod":"<merge-method>","requiredChecks":[]}}'`,
  docs: `--settings '{"docs":{"protocol":"<orch-docs|workspace-mcp|cursor-mcp|array-mcp>"}}'`,
  mainStack: `--settings '{"mainStack":{"consumers":[],"requiredServices":[]}}'`,
}

function commandFor(project: InjectableProject, source: InjectionSource): string {
  return source === 'stack'
    ? `orch project set ${project.name} --stack <stack>`
    : `orch project set ${project.name} ${settingCommands[source]}`
}

export type MissingWorkflowInjectionFact = {
  source: InjectionSource
  remedy: string
}

export class MissingWorkflowInjectionFactsError extends Error {
  readonly missing: MissingWorkflowInjectionFact[]

  constructor(project: InjectableProject, sources: InjectionSource[]) {
    const missing = sources.map((source) => ({
      source,
      remedy: `${source}; set with: ${commandFor(project, source)}`,
    }))
    super(
      `project ${project.name} is missing workflow injection facts:\n${missing
        .map(({ remedy }) => `- ${remedy}`)
        .join('\n')}`,
    )
    this.name = 'MissingWorkflowInjectionFactsError'
    this.missing = missing
  }
}

/** Resolve all requested register facts together, or refuse without returning a partial result. */
export function resolveInjection<
  Project extends InjectableProject,
  const Needs extends readonly InjectionSource[],
>(
  project: Project,
  needs: Needs,
  args: Record<string, string> = {},
): ResolvedInjection<Project, Needs> {
  const missing = [...new Set(needs)].filter((source) => {
    const value = source === 'stack' ? project.stack : project.settings[source]
    return source !== 'mainStack' && (value === undefined || value === null)
  })
  if (missing.length) {
    throw new MissingWorkflowInjectionFactsError(project, missing)
  }

  const resolved: Partial<InjectionValues<Project>> = {}
  for (const source of needs) {
    const value = source === 'stack' ? project.stack : project.settings[source]
    if (source === 'tracker') {
      const tracker = value as TrackerSettings
      const protocol = trackerProtocol(tracker.protocol)
      const actionNames = resolveTrackerAgentActions(protocol, tracker.actions)
      const actions = Object.fromEntries(
        Object.entries(actionNames).map(([action, name]) => [
          action,
          substituteAction(name, project.name, args.key),
        ]),
      ) as Partial<Record<TrackerAction, string>>
      const states = Object.fromEntries(
        (['active', 'review', 'done'] as const).flatMap((category) => {
          const raw = Object.entries(tracker.states ?? {}).find(
            ([, mapped]) => mapped === category,
          )?.[0]
          return raw ? [[category, raw]] : protocol === 'hub' ? [[category, category]] : []
        }),
      ) as ResolvedTracker['states']
      const reviewStages = resolvedReviewStages(project.name, tracker, protocol)
      if (tracker.reviewStages) states.review = tracker.reviewStages.active
      Object.assign(resolved, {
        tracker: {
          kind: tracker.kind ?? protocol,
          protocol,
          ...(protocol === 'hub' ? {} : { server: project.name }),
          actions,
          states,
          ...reviewStages,
        },
      })
    } else if (source === 'docs') {
      const docs = value as DocsSettings
      Object.assign(resolved, {
        docs: {
          ...docs,
          ...(docs.protocol === 'orch-docs' ? {} : { server: project.name }),
          ...docsAdapters[docs.protocol],
        },
      })
    } else if (source === 'mainStack') {
      const requiredServices = (value as InjectionSettings['mainStack'])?.requiredServices ?? []
      Object.assign(resolved, {
        mainStack: {
          requiredServices,
          requiredServicesText: requiredServices.join(' ') || 'none',
        },
      })
    } else Object.assign(resolved, { [source]: value })
  }
  return resolved as ResolvedInjection<Project, Needs>
}

/** Sources the workflow compose index resolves beside the steps' declared needs. */
export const composeIndexSources = ['docs', 'stack'] as const satisfies readonly InjectionSource[]

/** Resolve declared needs plus extras together; `facts` carries only the declared needs. */
export function resolveDeclaredFacts<Project extends InjectableProject>(
  project: Project,
  needs: readonly InjectionSource[],
  args: Record<string, string> = {},
  extras: readonly InjectionSource[] = [],
) {
  const declared = [...new Set(needs)]
  const resolved = resolveInjection(project, [...extras, ...declared], args)
  const facts = Object.fromEntries(declared.map((source) => [source, resolved[source]])) as Partial<
    InjectionValues<Project>
  >
  return { resolved, facts }
}

type ValidatedInjectionSettings = Pick<
  InjectionSettings,
  'tracker' | 'trunk' | 'release' | 'docs' | 'gate'
>

/** Validate the workflow-specific portion of a project settings blob at the register edge. */
export function validateProjectInjectionSettings(settings: ValidatedInjectionSettings): string[] {
  const problems: string[] = []
  for (const [name, schema] of [
    ['tracker', trackerSchema],
    ['release', releaseSchema],
    ['docs', docsSchema],
    ['gate', gateSchema],
    ['trunk', trunkSchema],
  ] as const) {
    if (settings[name] === undefined) continue
    let value: unknown = settings[name]
    if (
      name === 'release' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'deployCommand')
    ) {
      problems.push(
        'release.deployCommand: retired; move the command onto a rung: release.rungs[].deploy',
      )
      const { deployCommand: _retired, ...withoutRetiredKey } = value as Record<string, unknown>
      value = withoutRetiredKey
    }
    const result = schema.safeParse(value)
    if (!result.success) {
      problems.push(
        ...result.error.issues.map(
          (issue) =>
            `${name}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
        ),
      )
    }
  }
  return problems
}
