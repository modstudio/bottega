// concern: record-built-ins-identity
/** Identifies the shared built-in catalogue content and records which spaces hold it. */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../shared/canonical-json.ts'
import { writeTransaction } from '../database/db.ts'
import {
  BUILT_IN_LENS_DEFAULT_PROFILE,
  BUILT_IN_LENS_SLOTS,
  BUILT_IN_LENSES,
} from '../lens/lens-built-ins.ts'
import { builtInWorkflowCatalogue } from '../workflow/workflow-built-ins.ts'

type BuiltInsCatalogue = {
  lenses: unknown
  lensSlots: string
  lensDefaultProfile: string
  workflows: ReturnType<typeof builtInWorkflowCatalogue>
}

/** Hashes the catalogue with sorted keys, so content changes it and key order never does. */
export function builtInsIdentity(catalogue: BuiltInsCatalogue): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        lenses: catalogue.lenses,
        lensSlots: JSON.parse(catalogue.lensSlots),
        lensDefaultProfile: JSON.parse(catalogue.lensDefaultProfile),
        workflows: {
          stepCatalogue: {
            ...catalogue.workflows.stepCatalogue,
            definition: JSON.parse(catalogue.workflows.stepCatalogue.definition),
          },
          workflows: catalogue.workflows.workflows.map((workflow) => ({
            ...workflow,
            definition: JSON.parse(workflow.definition),
          })),
        },
      }),
    )
    .digest('hex')
}

const RECORD_BUILT_INS_IDENTITY = builtInsIdentity({
  lenses: BUILT_IN_LENSES,
  lensSlots: BUILT_IN_LENS_SLOTS,
  lensDefaultProfile: BUILT_IN_LENS_DEFAULT_PROFILE,
  workflows: builtInWorkflowCatalogue(),
})

const markerKey = (spaceId: string) => `record_built_ins:${spaceId}`

/** True when this store recorded that the space received the current built-ins. */
export function builtInsEnsured(local: Database, spaceId: string): boolean {
  const recorded = local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(markerKey(spaceId))?.value
  return recorded === RECORD_BUILT_INS_IDENTITY
}

export function recordBuiltInsEnsured(local: Database, spaceId: string): void {
  writeTransaction(
    () =>
      local
        .query(
          `INSERT INTO schema_meta (key,value) VALUES (?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run(markerKey(spaceId), RECORD_BUILT_INS_IDENTITY),
    local,
  )
}
