// concern: workflow passing-gate refusal evidence
/** Gathers an existing passing gate for refusal text without offering it to the floor. */

import type { Database } from 'bun:sqlite'
import { passingGateNumberForProjectCommit } from '../gate/gate-passing-lookup.ts'
import { projectAt, projectByName } from '../project/projects.ts'

type TreeEvidence = { project: string; commit: string | null }
type PassingGateEvidence = { number: number } | null | undefined
type FloorEvidence = { kind: string; commandEvidence?: string }

export function hasGateFloor(floors: FloorEvidence[]): boolean {
  return floors.some((floor) => floor.kind === 'command-exit' && floor.commandEvidence === 'gate')
}

export function gatherPassingGateForTree(
  tree: TreeEvidence,
  database: Database,
): PassingGateEvidence {
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
