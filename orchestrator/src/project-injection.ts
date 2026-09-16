// concern: project-injection
/** Knows the project facts shared workflows may request, their stored grammar, and refusal remedies. */
import { z } from 'zod'
import type { TrackerSettings } from '../../shared/trackers.ts'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) => z.strictObject(shape)

export const releaseSchema = strictObject({
  rungs: z.array(
    strictObject({
      name: z.string(),
      branch: z.string(),
      deploy: z.string().optional(),
    }),
  ),
  mergeMethod: z.enum(['squash', 'merge', 'rebase']),
  deployCommand: z.string().optional(),
  requiredChecks: z.array(z.string()),
  observationWindowHours: z.number().int().positive().optional(),
})

export const docsSchema = z.discriminatedUnion('protocol', [
  strictObject({ protocol: z.literal('orch-docs') }),
  strictObject({
    protocol: z.literal('mcp'),
    server: z.string(),
    read: z.array(z.string()).min(1),
    write: z.array(z.string()),
  }),
])

export const gateSchema = z.string().trim().min(1)

export type ReleaseSettings = z.infer<typeof releaseSchema>
export type DocsSettings = z.infer<typeof docsSchema>

type InjectionSettings = {
  tracker?: TrackerSettings
  gate?: string
  worktree?: unknown
  release?: ReleaseSettings
  docs?: DocsSettings
}

type InjectableProject = {
  name: string
  stack: string | null
  settings: InjectionSettings
}

export const injectionSources = ['tracker', 'gate', 'worktree', 'release', 'docs', 'stack'] as const
export type InjectionSource = (typeof injectionSources)[number]

type InjectionValues<Project extends InjectableProject> = {
  tracker: NonNullable<Project['settings']['tracker']>
  gate: NonNullable<Project['settings']['gate']>
  worktree: NonNullable<Project['settings']['worktree']>
  release: NonNullable<Project['settings']['release']>
  docs: NonNullable<Project['settings']['docs']>
  stack: NonNullable<Project['stack']>
}

type ResolvedInjection<
  Project extends InjectableProject,
  Needs extends readonly InjectionSource[],
> = Pick<InjectionValues<Project>, Needs[number]>

const settingCommands: Record<Exclude<InjectionSource, 'stack'>, string> = {
  tracker: `--settings '{"tracker":{"protocol":"<protocol>"}}'`,
  gate: `--settings '{"gate":"<command>"}'`,
  worktree: `--settings '{"worktree":{}}'`,
  release: `--settings '{"release":{"rungs":[],"mergeMethod":"<merge-method>","requiredChecks":[]}}'`,
  docs: `--settings '{"docs":{"protocol":"<orch-docs|mcp>"}}'`,
}

function commandFor(project: InjectableProject, source: InjectionSource): string {
  return source === 'stack'
    ? `orch project set ${project.name} --stack <stack>`
    : `orch project set ${project.name} ${settingCommands[source]}`
}

/** Resolve all requested register facts together, or refuse without returning a partial result. */
export function resolveInjection<
  Project extends InjectableProject,
  const Needs extends readonly InjectionSource[],
>(project: Project, needs: Needs): ResolvedInjection<Project, Needs> {
  const missing = [...new Set(needs)].filter((source) => {
    const value = source === 'stack' ? project.stack : project.settings[source]
    return value === undefined || value === null
  })
  if (missing.length) {
    throw new Error(
      `project ${project.name} is missing workflow injection facts:\n${missing
        .map((source) => `- ${source}; set with: ${commandFor(project, source)}`)
        .join('\n')}`,
    )
  }

  const resolved: Partial<InjectionValues<Project>> = {}
  for (const source of needs) {
    const value = source === 'stack' ? project.stack : project.settings[source]
    Object.assign(resolved, { [source]: value })
  }
  return resolved as ResolvedInjection<Project, Needs>
}

type ValidatedInjectionSettings = Pick<InjectionSettings, 'release' | 'docs' | 'gate'>

/** Validate the workflow-specific portion of a project settings blob at the register edge. */
export function validateProjectInjectionSettings(settings: ValidatedInjectionSettings): string[] {
  const problems: string[] = []
  for (const [name, schema] of [
    ['release', releaseSchema],
    ['docs', docsSchema],
    ['gate', gateSchema],
  ] as const) {
    if (settings[name] === undefined) continue
    const result = schema.safeParse(settings[name])
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
