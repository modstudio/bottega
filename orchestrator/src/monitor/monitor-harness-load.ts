// concern: monitor-harness-load
/** Measures registered projects' architect harness load and decides which plans need attention. */

import { HARNESS_NAMES, type LoadPlan, planHarnessLoad } from '../canon/canon-load.ts'
import { gatherHarnessLoadFacts } from '../canon/canon-load-files.ts'
import type { Project } from '../project/projects.ts'
import type { MonitorCondition } from './monitor-types.ts'

type HarnessLoadCondition = Omit<MonitorCondition, 'ageMs'>

function largestAlwaysOnFiles(plan: LoadPlan): string {
  const files = plan.files
    .filter((file) => file.kind === 'always-on')
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path))
    .slice(0, 3)
    .map((file) => `${file.path} (${file.size} ${plan.unit})`)
  return files.length > 0 ? files.join(', ') : 'none'
}

/** Decide whether one measured architect load plan exceeds its harness's enforced limit. */
export function harnessLoadCondition(
  project: Pick<Project, 'name' | 'path'>,
  plan: LoadPlan,
): HarnessLoadCondition | null {
  const raises =
    (plan.harness === 'claude' && plan.status === 'over') ||
    (plan.harness === 'codex' && plan.status === 'truncated')
  if (!raises || plan.limit === null) return null
  return {
    kind: 'harness-load-over-limit',
    subject: `${project.name}:${plan.harness}`,
    since: null,
    detail:
      `${project.name} ${plan.harness} architect load measured ${plan.total} ${plan.unit}; ` +
      `limit ${plan.limit} ${plan.unit}; largest always-on files: ${largestAlwaysOnFiles(plan)}`,
    action: `run orch canon load --cwd ${project.path} --harness ${plan.harness}`,
    affectedProject: project.name,
  }
}

/** Read one checkout once and report each harness plan without changing the checkout. */
export function observeProjectHarnessLoad(
  project: Pick<Project, 'name' | 'path'>,
  env: NodeJS.ProcessEnv = process.env,
): MonitorCondition[] {
  try {
    const facts = gatherHarnessLoadFacts(project.path, env)
    return HARNESS_NAMES.flatMap((harness) => {
      const condition = harnessLoadCondition(project, planHarnessLoad(facts, harness))
      return condition ? [{ ...condition, ageMs: null }] : []
    })
  } catch (cause) {
    return [
      {
        kind: 'observation-error',
        subject: `harness-load:${project.name}`,
        since: null,
        ageMs: null,
        detail: `${project.name} harness load observation unavailable: ${String((cause as Error).message ?? cause)}`,
        action: `reported; restore readable checkout ${project.path}, then run orch monitor`,
        affectedProject: project.name,
      },
    ]
  }
}
