// concern: record-cache-projects
/** Pulls authoritative hosted project fields into already-linked local register rows. */

import type { Database } from 'bun:sqlite'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { tryWriteContention, writeTransaction } from '../database/db.ts'
import { mirrorProjectRegisterRow } from '../database/project-register-store.ts'
import { decideProjectRegisterPull } from '../project/project-pull-decision.ts'
import { applyLocalProjectRename } from '../project/project-rename.ts'
import { projectSettingsForStorage, projects } from '../project/projects.ts'
import type { RecordApiClient } from './record-api-client.ts'

export type ProjectRegisterPullResult = {
  updated: number
  retired: number
  unretired: number
  skipped: number
  warnings: string[]
}

export async function pullProjectRegister(
  local: Database,
  spaces: readonly string[],
  client: Pick<RecordApiClient, 'listProjects'>,
): Promise<ProjectRegisterPullResult> {
  const hostedRows: RecordProject[] = []
  for (const spaceId of spaces) {
    hostedRows.push(...(await client.listProjects({ destinationSpaceId: spaceId })))
  }
  const localRows = [...projects(undefined, local), ...projects({ retired: true }, local)]
  const decisions = decideProjectRegisterPull(localRows, hostedRows)
  const updates = decisions.filter((decision) => decision.kind === 'update')
  const warnings = decisions
    .filter((decision) => decision.kind === 'skip')
    .map((decision) => decision.reason)
  let retired = 0
  let unretired = 0
  writeTransaction(() => {
    for (const update of updates) {
      const previous = localRows.find((row) => row.recordId === update.project.recordId)!
      if (update.previousName !== update.project.name) {
        applyLocalProjectRename(
          { recordId: update.project.recordId },
          update.previousName,
          update.project.name,
          local,
        )
      }
      const changed = mirrorProjectRegisterRow(local, {
        recordId: update.project.recordId,
        name: update.project.name,
        stack: update.project.stack,
        canon: update.project.canon,
        settings: projectSettingsForStorage(update.project.settings),
        retiredAt: update.project.retiredAt,
      })
      if (changed !== 1) {
        throw new Error(
          `project ${update.previousName} changed while the hosted register was being pulled; retry record sync`,
        )
      }
      if (!previous.retiredAt && update.project.retiredAt) retired++
      if (previous.retiredAt && !update.project.retiredAt) unretired++
    }
  }, local)
  for (const update of updates) {
    if (update.previousTrunk === update.nextTrunk) continue
    tryWriteContention({
      resourceKind: 'register',
      resourceKey: update.project.name,
      eventKind: 'invalidation',
      cause: `trunk ${update.previousTrunk ?? '(unset)'} -> ${update.nextTrunk ?? '(unset)'}`,
    })
  }
  return {
    updated: updates.length,
    retired,
    unretired,
    skipped: warnings.length,
    warnings,
  }
}
