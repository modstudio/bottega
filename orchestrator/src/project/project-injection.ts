// concern: project-injection
/** Knows the project facts shared workflows may request, their stored grammar, and refusal remedies. */
import { isAbsolute, normalize, posix, win32 } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  PHP_POLICY_RULES,
  type PhpPolicyRule,
} from '../../../shared/test-substance/test-substance.ts'
import {
  refuseHubActionOverrides,
  refuseInvalidReviewStages,
  refuseNonCursorProjectId,
  resolveTrackerAgentActions,
  TRACKER_PROTOCOLS,
  type TrackerAction,
  type TrackerProtocol,
  type TrackerSettings,
  trackerActionsShape,
  trackerReviewStagesShape,
  trackerSettingsShape,
} from '../../../shared/trackers.ts'
import { mechanicalCheckEntryIssues } from '../enforcement/mechanical-check-declaration.ts'
import {
  REVIEW_RECORD_PLACEHOLDERS,
  reviewRecordTemplateProblem,
} from './review-record-template.ts'

/**
 * One settings grammar, two object modes, because the register is written by
 * one binary and read by another.
 *
 * A write refuses a key this binary does not know, which is how a typo in
 * `--settings` is caught. A read drops one, because a newer binary may have
 * written a key this one has never heard of and reading the register in an
 * older tree is ordinary: refusing there takes the whole project, and every
 * workflow that needs it, out of the register at once.
 */
export type SettingsObjectMode = 'strict' | 'strip'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) => z.strictObject(shape)

/** The same grammar in the mode its reader declares, and one type for both. */
const objectIn = (mode: SettingsObjectMode) =>
  mode === 'strict'
    ? strictObject
    : <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
        // Both modes accept the same known keys and produce the same value, so
        // the strip schema carries the strict one's type; only its verdict on a
        // key this binary does not know differs.
        z.object(shape) as unknown as ReturnType<typeof strictObject<Shape>>

const releaseEntryPoint = z
  .string()
  .trim()
  .min(1)
  .superRefine((entry, context) => {
    if (isAbsolute(entry) || win32.isAbsolute(entry)) {
      context.addIssue({ code: 'custom', message: 'must be a repository-relative file path' })
    } else if (entry.split(/[\\/]/).includes('..')) {
      context.addIssue({ code: 'custom', message: 'must not contain a .. path segment' })
    } else if (/[*?[{]/.test(entry)) {
      context.addIssue({ code: 'custom', message: 'must not contain glob characters' })
    }
  })

const releaseSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    rungs: z
      .array(
        objectIn(mode)({
          name: z.string(),
          branch: z.string(),
          deploy: z.string().optional(),
          live: z.string().trim().min(1).optional(),
          onDemand: z.boolean().optional(),
          requiredWhenChanged: z.array(z.string().trim().min(1)).optional(),
          entryPoints: z.array(releaseEntryPoint).min(1).optional(),
          releasesWhenChanged: z.array(z.string().trim().min(1)).min(1).optional(),
        }),
      )
      .superRefine((rungs, context) => {
        const seen = new Set<string>()
        for (const [index, rung] of rungs.entries()) {
          if (rung.requiredWhenChanged !== undefined && rung.live === undefined) {
            context.addIssue({
              code: 'custom',
              path: [index, 'requiredWhenChanged'],
              message: `release rung "${rung.name}" declares requiredWhenChanged; add a live probe or drop requiredWhenChanged`,
            })
          }
          if (rung.entryPoints !== undefined && rung.live === undefined) {
            context.addIssue({
              code: 'custom',
              path: [index, 'entryPoints'],
              message: `release rung "${rung.name}" declares entryPoints; add a live probe or drop entryPoints`,
            })
          }
          if (seen.has(rung.name)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `release rung name "${rung.name}" is repeated; use each name at most once`,
            })
          }
          seen.add(rung.name)
        }
      }),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']),
    requiredChecks: z.array(z.string()),
    beforePullRequest: z
      .array(
        objectIn(mode)({
          whenChanged: z.array(z.string().trim().min(1)).min(1),
          run: z.string(),
          secrets: z.array(z.string().trim().min(1)).optional(),
        }),
      )
      .optional(),
    mergeQueue: z.boolean().optional(),
    observationWindowHours: z.number().int().positive().optional(),
  })

const docsSchema = (mode: SettingsObjectMode) =>
  z.discriminatedUnion('protocol', [
    objectIn(mode)({ protocol: z.literal('orch-docs') }),
    objectIn(mode)({ protocol: z.literal('workspace-mcp') }),
    objectIn(mode)({ protocol: z.literal('cursor-mcp') }),
    objectIn(mode)({ protocol: z.literal('array-mcp') }),
  ])

const referenceSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    directory: z
      .string()
      .min(1)
      .superRefine((directory, context) => {
        if (directory !== directory.trim()) {
          context.addIssue({ code: 'custom', message: `must be written as ${directory.trim()}` })
          return
        }
        if (isAbsolute(directory) || win32.isAbsolute(directory)) {
          context.addIssue({ code: 'custom', message: 'must be a repository-relative path' })
          return
        }
        const normalized = normalize(directory)
        const normalizedWindows = win32.normalize(directory)
        if (
          normalized === '..' ||
          normalized.startsWith('../') ||
          normalized.startsWith('..\\') ||
          normalizedWindows === '..' ||
          normalizedWindows.startsWith('..\\')
        ) {
          context.addIssue({
            code: 'custom',
            message: 'must not escape the repository',
          })
          return
        }
        // The merge step compares changed paths with this spelling, so only the canonical one is stored.
        const canonical = posix.normalize(directory.replaceAll('\\', '/')).replace(/\/+$/, '')
        if (canonical === '.')
          context.addIssue({
            code: 'custom',
            message: 'must name a directory inside the repository',
          })
        else if (canonical !== directory)
          context.addIssue({ code: 'custom', message: `must be written as ${canonical}` })
      }),
    publish: z.string().trim().min(1),
  })

const signalsSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    sources: z.array(
      objectIn(mode)({
        name: z.string().trim().min(1),
        list: z.string().trim().min(1),
        get: z.string().trim().min(1).optional(),
      }),
    ),
  })

const reviewRiskSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    paths: z.array(
      objectIn(mode)({
        pattern: z
          .custom<string>(
            (pattern) => typeof pattern === 'string',
            'must be a regular-expression string; replace it with a valid regular expression over repository-relative paths',
          )
          .superRefine((pattern, context) => {
            try {
              new RegExp(pattern)
            } catch (cause) {
              context.addIssue({
                code: 'custom',
                message: `does not compile (${cause instanceof Error ? cause.message : String(cause)}); replace it with a valid regular expression over repository-relative paths`,
              })
            }
          }),
        tier: z.custom<1 | 2 | 3>(
          (tier) => tier === 1 || tier === 2 || tier === 3,
          'must be 1, 2, or 3; replace it with a supported risk tier',
        ),
        reason: z.custom<string>(
          (reason) => typeof reason === 'string' && reason.trim().length > 0,
          'must be a non-empty short phrase; replace it with the reason for this path risk',
        ),
        basis: z.string().trim().min(1).optional(),
        firm: z
          .literal(
            true,
            'must be true or omitted; omit firm for a path whose risk may lower with size',
          )
          .optional(),
      }),
    ),
    unlisted: z.custom<0 | 1 | 2>(
      (tier) => tier === 0 || tier === 1 || tier === 2,
      'must be 0, 1, or 2; replace it with the risk tier for an unlisted product path',
    ),
  })

const reviewSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    lenses: z.array(
      objectIn(mode)({
        lens: z.string().trim().min(1),
        paths: z.array(z.string().trim().min(1)).optional(),
        minTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        basis: z.string().trim().min(1).optional(),
      }),
    ),
    secondOpinion: objectIn(mode)({
      lens: z.string().trim().min(1),
      minTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      basis: z.string().trim().min(1).optional(),
    }).optional(),
    unscopedLenses: z.enum(['all', 'skip']).optional(),
    risk: reviewRiskSchema(mode).optional(),
    record: z.string().trim().min(1).optional(),
  }).superRefine((review, context) => {
    if (!review.record) return
    const problem = reviewRecordTemplateProblem(review.record)
    if (!problem) return
    context.addIssue({
      code: 'custom',
      path: ['record'],
      message:
        `${problem}; valid placeholders: ${REVIEW_RECORD_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}; ` +
        `set with: ${PLATFORM_SLUG} project set <project> --settings '{"review":{"lenses":[],"record":"<command> {findings}"}}'`,
    })
  })

const testSubstanceSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    phpPolicyRules: z
      .array(
        z.custom<PhpPolicyRule>(
          (rule) => typeof rule === 'string' && PHP_POLICY_RULES.includes(rule as PhpPolicyRule),
          `unknown PHP policy rule; valid rules: ${PHP_POLICY_RULES.join(', ')}; set with: ${PLATFORM_SLUG} project set <project> --settings '{"testSubstance":{"phpPolicyRules":["<rule>"]}}'`,
        ),
      )
      .superRefine((rules, context) => {
        const seen = new Set<string>()
        for (const [index, rule] of rules.entries()) {
          if (seen.has(rule)) {
            context.addIssue({
              code: 'custom',
              path: [index],
              message: `PHP policy rule "${rule}" is repeated; use each valid rule at most once; set with: ${PLATFORM_SLUG} project set <project> --settings '{"testSubstance":{"phpPolicyRules":["<rule>"]}}'`,
            })
          }
          seen.add(rule)
        }
      }),
  })

const mechanicalChecksRemedy = `set with: ${PLATFORM_SLUG} project set <project> --settings '{"mechanicalChecks":{"<category>":{"tool":"<command>"}}}'`

const mechanicalChecksSchema = (mode: SettingsObjectMode) =>
  z.record(z.string(), z.unknown()).superRefine((entries, context) => {
    for (const [identifier, raw] of Object.entries(entries)) {
      for (const issue of mechanicalCheckEntryIssues(identifier, raw, mode)) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: `${issue.message}; ${mechanicalChecksRemedy}`,
        })
      }
    }
  })

const gateSchema = z.string().trim().min(1)
const trunkSchema = z.string().trim().min(1)
// The shared shape keeps protocol open so hub can read any stored row; the
// register edge accepts only protocols a workflow can act on.
const trackerSchema = (mode: SettingsObjectMode) =>
  objectIn(mode)({
    ...trackerSettingsShape,
    protocol: z.enum(TRACKER_PROTOCOLS),
    // The shared shape fixes these two inner objects strict, so a reader
    // overrides them with the same fields in the mode it declares.
    reviewStages: objectIn(mode)(trackerReviewStagesShape).optional(),
    actions: objectIn(mode)(trackerActionsShape).optional(),
  }).superRefine((tracker, context) => {
    refuseHubActionOverrides(tracker, context)
    refuseNonCursorProjectId(tracker, context)
    refuseInvalidReviewStages(tracker, context)
  })

export type ReleaseSettings = z.infer<ReturnType<typeof releaseSchema>>
export type DocsSettings = z.infer<ReturnType<typeof docsSchema>>
export type ReferenceSettings = z.infer<ReturnType<typeof referenceSchema>>
export type SignalsSettings = z.infer<ReturnType<typeof signalsSchema>>
export type ReviewRiskMap = z.infer<ReturnType<typeof reviewRiskSchema>>
export type ReviewSettings = z.infer<ReturnType<typeof reviewSchema>>
export type TestSubstanceSettings = z.infer<ReturnType<typeof testSubstanceSchema>>
type ResolvedDocs = DocsSettings & {
  server?: string
  read: string[]
  write: string[]
}
export type ResolvedReviewStage = {
  state: string
  floor: 'tracker-transition' | 'recorded-artifact'
}
type ResolvedTracker = {
  kind: string
  protocol: TrackerProtocol
  completesOnMerge: boolean
  server?: string
  actions: Partial<Record<TrackerAction, string>>
  states: Partial<Record<'active' | 'review' | 'done', string>>
  waitingReview: ResolvedReviewStage
  inReview: ResolvedReviewStage
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

function resolvedReviewStages(
  projectName: string,
  tracker: TrackerSettings,
  protocol: TrackerProtocol,
  review: ReviewSettings | undefined,
) {
  const reviewStates = Object.entries(tracker.states ?? {}).flatMap(([raw, category]) =>
    category === 'review' ? [raw] : [],
  )
  const defaultReviewState = protocol === 'hub' ? 'review' : undefined
  if (defaultReviewState && reviewStates.length === 0) reviewStates.push(defaultReviewState)
  if (!tracker.reviewStages && reviewStates.length > 1) {
    throw new Error(
      `project ${projectName} tracker has several review states (${reviewStates.join(', ')}) but no reviewStages selection; set it with: ${PLATFORM_SLUG} project set ${projectName} --settings '${JSON.stringify({ tracker: { reviewStages: { waiting: '<waiting-review-state>', active: '<in-review-state>' } } })}'`,
    )
  }
  const waiting = tracker.reviewStages?.waiting ?? reviewStates[0]
  const active = tracker.reviewStages?.active ?? reviewStates[0]
  const stage = (state: string | undefined): ResolvedReviewStage =>
    state ? { state, floor: 'tracker-transition' } : { state: 'none', floor: 'recorded-artifact' }
  // A declared review-record command writes the review state after the review, so entering
  // review only records that; the state stays named for the steps that close out.
  const declared = stage(active)
  const inReview: ResolvedReviewStage =
    declared.state !== 'none' && review?.record
      ? { ...declared, floor: 'recorded-artifact' }
      : declared
  return { waitingReview: stage(waiting), inReview }
}

function resolvedTracker(
  project: InjectableProject,
  tracker: TrackerSettings,
  args: Record<string, string>,
): ResolvedTracker {
  const protocol = trackerProtocol(tracker.protocol)
  const actionNames = resolveTrackerAgentActions(protocol, tracker.actions)
  const actions = Object.fromEntries(
    Object.entries(actionNames).map(([action, name]) => [
      action,
      substituteAction(name, project.name, args.key),
    ]),
  ) as Partial<Record<TrackerAction, string>>
  const states = Object.fromEntries(
    (['active', 'done'] as const).flatMap((category) => {
      const raw = Object.entries(tracker.states ?? {}).find(
        ([, mapped]) => mapped === category,
      )?.[0]
      return raw ? [[category, raw]] : protocol === 'hub' ? [[category, category]] : []
    }),
  ) as ResolvedTracker['states']
  const reviewStages = resolvedReviewStages(
    project.name,
    tracker,
    protocol,
    project.settings.review,
  )
  if (reviewStages.inReview.state !== 'none') states.review = reviewStages.inReview.state
  return {
    kind: tracker.kind ?? protocol,
    protocol,
    completesOnMerge: tracker.completesOnMerge ?? false,
    ...(protocol === 'hub' ? {} : { server: project.name }),
    actions,
    states,
    ...reviewStages,
  }
}

type InjectionSettings = {
  tracker?: TrackerSettings
  trunk?: string
  gate?: string
  worktree?: unknown
  release?: ReleaseSettings
  docs?: DocsSettings
  reference?: ReferenceSettings
  signals?: SignalsSettings
  review?: ReviewSettings
  testSubstance?: TestSubstanceSettings
  mechanicalChecks?: unknown
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
  'signals',
  'review',
  'stack',
  'mainStack',
] as const
export type InjectionSource = (typeof injectionSources)[number]
export const workflowFactSources = [
  ...injectionSources,
  'before-pull-request',
  'reference',
  'ship-to',
  'merged-change',
  'workflow-text',
] as const
export type WorkflowFactSource = (typeof workflowFactSources)[number]

type InjectionValues<Project extends InjectableProject> = {
  tracker: ResolvedTracker
  trunk: NonNullable<Project['settings']['trunk']>
  gate: NonNullable<Project['settings']['gate']>
  worktree: NonNullable<Project['settings']['worktree']>
  release: NonNullable<Project['settings']['release']>
  docs: ResolvedDocs
  signals: NonNullable<Project['settings']['signals']>
  review: NonNullable<Project['settings']['review']>
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
  signals: `--settings '{"signals":{"sources":[{"name":"<label>","list":"<command-or-tool>"}]}}'`,
  review: `--settings '{"review":{"lenses":[{"lens":"<catalogue-lens-id>"}]}}'`,
  mainStack: `--settings '{"mainStack":{"consumers":[],"requiredServices":[]}}'`,
}

function commandFor(project: InjectableProject, source: InjectionSource): string {
  return source === 'stack'
    ? `${PLATFORM_SLUG} project set ${project.name} --stack <stack>`
    : `${PLATFORM_SLUG} project set ${project.name} ${settingCommands[source]}`
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
      Object.assign(resolved, { tracker: resolvedTracker(project, value as TrackerSettings, args) })
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

export type ValidatedInjectionSettings = Pick<
  InjectionSettings,
  | 'tracker'
  | 'trunk'
  | 'release'
  | 'docs'
  | 'reference'
  | 'signals'
  | 'gate'
  | 'review'
  | 'testSubstance'
  | 'mechanicalChecks'
>

/**
 * Validate the workflow-specific portion of a project settings blob at the
 * register edge, in the mode its reader or writer declares.
 */
export function validateProjectInjectionSettings(
  settings: ValidatedInjectionSettings,
  mode: SettingsObjectMode,
): string[] {
  const problems: string[] = []
  for (const [name, schema] of [
    ['tracker', trackerSchema(mode)],
    ['release', releaseSchema(mode)],
    ['docs', docsSchema(mode)],
    ['reference', referenceSchema(mode)],
    ['signals', signalsSchema(mode)],
    ['review', reviewSchema(mode)],
    ['testSubstance', testSubstanceSchema(mode)],
    ['mechanicalChecks', mechanicalChecksSchema(mode)],
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
