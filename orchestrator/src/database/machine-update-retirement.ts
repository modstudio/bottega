// concern: post-update default local project retirement
/** Releases hosted rows, then retires an unused default local project only on a bound install. */

import { type Database } from 'bun:sqlite'
import {
  attemptDefaultLocalProjectRetirement,
  retireUnusedDefaultLocalProject,
} from '../project/default-local-project-retirement.ts'
import { storeHasAttachedToHostedRecord } from '../record/install-binding.ts'
import { recordSessionPresent } from '../record/record-session.ts'
import { withSynchronousDatabaseForMigrationStep } from './db.ts'
import { releaseHostedRowsAfterUpdate } from './hosted-row-release.ts'

type Presentation = { log(value: string): void }

export type UpdateRetirementDependencies = {
  releaseHostedRows?: (presentation: Presentation) => Promise<void>
  retireDefaultLocalProject?: () => Promise<boolean>
  storeAttachedToHostedRecord?: () => boolean
  recordSessionPresent?: () => boolean
  withDatabase?: <T>(fn: (database: Database) => T) => T
}

export async function releaseHostedRowsAndRetireDefaultProject(
  presentation: Presentation,
  deps: UpdateRetirementDependencies,
): Promise<void> {
  await (deps.releaseHostedRows ?? releaseHostedRowsAfterUpdate)(presentation)
  try {
    const attached =
      deps.storeAttachedToHostedRecord?.() ??
      (deps.withDatabase ?? withSynchronousDatabaseForMigrationStep)(storeHasAttachedToHostedRecord)
    if (!attached && !(deps.recordSessionPresent ?? recordSessionPresent)()) return
    await attemptDefaultLocalProjectRetirement(
      presentation,
      deps.retireDefaultLocalProject ?? retireUnusedDefaultLocalProject,
    )
  } catch (error) {
    presentation.log(
      `default local project retirement failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
