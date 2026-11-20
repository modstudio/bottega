// concern: workflow passing-gate refusal evidence
/** Gathers an existing passing gate for refusal text without offering it to the floor. */

import type { Database } from 'bun:sqlite'
import { passingGateNumberForProjectCommit } from '../gate/gate-passing-lookup.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import type { PassingGateForTree } from './workflow-floor-refusal.ts'

type TreeEvidence = { project: string; commit: string | null }

export function gatherPassingGateForTree(
  tree: TreeEvidence,
  database: Database,
): PassingGateForTree {
  if (!tree.commit) return undefined
  const project = projectByName(tree.project, database)
  if (!project) return null
  const number = passingGateNumberForProjectCommit(
    database,
    tree.commit,
    project.recordId,
    (cwd) => projectAt(cwd, database)?.recordId ?? null,
  )
  return number === null ? null : { number }
}
