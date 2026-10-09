// concern: monitor-canon-drift
/** Compares managed projects' landed trees with stored canon without modifying either. */

import {
  EMPTY_PROJECT_CANON_IMPORT_REMEDY,
  EMPTY_PROJECT_CANON_STORE_CONDITION,
} from '../canon/canon-empty-store-refusal.ts'
import { type CanonTreeAtRef, collectCanonTreeAtRef } from '../canon/canon-files.ts'
import {
  emptyStoreHydrationRefusal,
  type HydrationDrift,
  hydrationDrift,
  planHydration,
} from '../canon/canon-hydrate.ts'
import { storedRepositoryCanonRows } from '../canon/canon-stored-rows.ts'
import type { Project } from '../project/projects.ts'
import type { MonitorCondition, UnaddressedMonitorCondition } from './monitor-types.ts'

const DISPLAYED_DRIFT_PATHS = 5
type CanonDriftCondition = Omit<UnaddressedMonitorCondition, 'ageMs'>

/** Decide whether one readable landed tree needs its stored canon hydrated. */
export function canonDriftCondition(
  project: Pick<Project, 'name'>,
  comparison: Pick<CanonTreeAtRef, 'ref' | 'commit'> & {
    drift: HydrationDrift[]
    projectRowCount: number
    deleteCount: number
  },
): CanonDriftCondition | null {
  const { drift } = comparison
  if (
    emptyStoreHydrationRefusal({
      projectRowCount: comparison.projectRowCount,
      deleteCount: comparison.deleteCount,
    })
  ) {
    return {
      kind: 'canon-drift',
      subject: project.name,
      since: null,
      detail: `${project.name}: ${EMPTY_PROJECT_CANON_STORE_CONDITION}`,
      action: EMPTY_PROJECT_CANON_IMPORT_REMEDY,
      affectedProject: project.name,
    }
  }
  if (drift.length === 0) return null
  const displayed = drift.slice(0, DISPLAYED_DRIFT_PATHS).map(({ path }) => path)
  const remainder = drift.length - displayed.length
  return {
    kind: 'canon-drift',
    subject: project.name,
    since: null,
    detail: `${project.name} landed canon at ${comparison.ref} (${comparison.commit}) differs from stored canon: ${displayed.join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}`,
    action: 'run orch canon hydrate in a worktree, commit the hydrated paths, and land the branch',
    affectedProject: project.name,
  }
}

/** Read one managed project's landed ref and canon store, returning visible observation failures. */
export function observeProjectCanonDrift(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
): MonitorCondition[] {
  if (project.settings.managedContext !== true) return []
  try {
    const trunk = project.settings.trunk?.trim()
    if (!trunk) throw new Error('registered project has no landing branch in settings.trunk')
    const landed = collectCanonTreeAtRef(project.path, `origin/${trunk}`)
    const rows = storedRepositoryCanonRows(project.name)
    const plan = planHydration({ rows, tree: landed.tree })
    const condition = canonDriftCondition(project, {
      ref: landed.ref,
      commit: landed.commit,
      drift: hydrationDrift(plan),
      projectRowCount: rows.filter((row) => row.subject === project.name).length,
      deleteCount: plan.deletes.length,
    })
    return condition ? [{ ...condition, ageMs: null }] : []
  } catch (cause) {
    return [
      {
        kind: 'observation-error',
        subject: `canon-drift:${project.name}`,
        since: null,
        ageMs: null,
        detail: `${project.name} canon drift observation unavailable: ${String((cause as Error).message ?? cause)}`,
        action: `reported; restore readable remote-tracking landing tree in ${project.path} and canon store, then run orch monitor`,
        affectedProject: project.name,
      },
    ]
  }
}
