// concern: project-pull-decision
/** Decides how hosted project rows change the local register without performing I/O. */

import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { PROJECT_SETTINGS_NOT_IMPORTED } from '../record/record-project-columns.ts'
import type { ProjectSettings } from './project-settings.ts'
import { type Project, validateProjectSettings } from './projects.ts'

export type ProjectPullDecision =
  | { kind: 'no-change'; project: string }
  | { kind: 'skip'; project: string; reason: string }
  | {
      kind: 'update'
      previousName: string
      project: Project
      previousTrunk: string | null
      nextTrunk: string | null
    }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function mergedSettings(local: ProjectSettings, hosted: RecordProject): ProjectSettings {
  const localOnly = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  return Object.fromEntries([
    ...Object.entries(local).filter(([key]) => localOnly.has(key)),
    ...Object.entries(hosted.settings ?? {}).filter(([key]) => !localOnly.has(key)),
  ]) as ProjectSettings
}

function trunk(settings: ProjectSettings): string | null {
  return typeof settings.trunk === 'string' ? settings.trunk : null
}

function sameProject(left: Project, right: Project): boolean {
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.stack === right.stack &&
    left.canon === right.canon &&
    left.retiredAt === right.retiredAt &&
    stable(left.settings) === stable(right.settings)
  )
}

export function decideProjectRegisterPull(
  localRows: readonly Project[],
  hostedRows: readonly RecordProject[],
): ProjectPullDecision[] {
  const hostedById = new Map(hostedRows.map((row) => [row.id, row]))
  return localRows.flatMap((local): ProjectPullDecision[] => {
    const hosted = hostedById.get(local.recordId)
    if (!hosted) return []
    const collision = localRows.find(
      (candidate) => candidate.recordId !== local.recordId && candidate.name === hosted.name,
    )
    if (collision) {
      return [
        {
          kind: 'skip',
          project: local.name,
          reason: `project ${local.name} cannot mirror hosted name ${hosted.name} because it collides with local project ${collision.name}`,
        },
      ]
    }
    const settings = mergedSettings(local.settings, hosted)
    const candidate: Project = {
      ...local,
      name: hosted.name,
      stack: hosted.stack,
      canon: hosted.canon ?? local.canon,
      settings,
      retiredAt: hosted.retiredAt,
    }
    const problems = validateProjectSettings(settings, 'strip', local.path, {
      validateKeyPrefixes: Object.hasOwn(settings, 'keyPrefixes'),
      currentProjectName: local.name,
      projectNameAfterWrite: hosted.name,
      register: [...localRows],
    })
    if (problems.length) {
      return [
        {
          kind: 'skip',
          project: local.name,
          reason: `hosted project ${hosted.name} has invalid settings: ${problems.join('; ')}`,
        },
      ]
    }
    if (sameProject(local, candidate)) return [{ kind: 'no-change', project: local.name }]
    return [
      {
        kind: 'update',
        previousName: local.name,
        project: candidate,
        previousTrunk: trunk(local.settings),
        nextTrunk: trunk(settings),
      },
    ]
  })
}
