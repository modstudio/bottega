// concern: project-pull-decision
/** Decides how hosted project rows change the local register without performing I/O. */

import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { PROJECT_SETTINGS_NOT_IMPORTED } from '../record/record-project-columns.ts'
import { type ProjectSettings, stableSettingsJson } from './project-settings.ts'
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

/**
 * Overlays the values the hosted row holds. A hosted value that is absent or null keeps the
 * local one, so a row the hosted record never received cannot erase local settings.
 */
function mergedSettings(
  local: ProjectSettings,
  hosted: NonNullable<RecordProject['settings']>,
): ProjectSettings {
  const localOnly = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  return {
    ...local,
    ...Object.fromEntries(
      Object.entries(hosted).filter(
        ([key, value]) => !localOnly.has(key) && value !== null && value !== undefined,
      ),
    ),
  } as ProjectSettings
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
    stableSettingsJson(left.settings) === stableSettingsJson(right.settings)
  )
}

/** Downgrades updates that would converge on one local name, which the register's unique name forbids. */
function withoutConvergentRenames(decisions: ProjectPullDecision[]): ProjectPullDecision[] {
  const claimants = new Map<string, string[]>()
  for (const decision of decisions) {
    if (decision.kind !== 'update') continue
    claimants.set(decision.project.name, [
      ...(claimants.get(decision.project.name) ?? []),
      decision.previousName,
    ])
  }
  return decisions.map((decision) => {
    if (decision.kind !== 'update') return decision
    const names = claimants.get(decision.project.name) ?? []
    if (names.length < 2) return decision
    return {
      kind: 'skip',
      project: decision.previousName,
      reason: `projects ${names.join(' and ')} would all take hosted name ${decision.project.name}; rename one of them in the space, then retry record sync`,
    }
  })
}

export function decideProjectRegisterPull(
  localRows: readonly Project[],
  hostedRows: readonly RecordProject[],
): ProjectPullDecision[] {
  return withoutConvergentRenames(decideEachProject(localRows, hostedRows))
}

function decideEachProject(
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
    if (!hosted.settings) {
      return [
        {
          kind: 'skip',
          project: local.name,
          reason: `hosted project ${hosted.name} came from a record server that predates project settings; release the record API, then retry record sync`,
        },
      ]
    }
    const settings = mergedSettings(local.settings, hosted.settings)
    const candidate: Project = {
      ...local,
      name: hosted.name,
      stack: hosted.stack ?? local.stack,
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
