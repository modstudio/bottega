// concern: record-built-ins-identity
/** Identifies the exact shared built-in catalogue content sent to a hosted space. */
import { createHash } from 'node:crypto'
import {
  BUILT_IN_LENS_DEFAULT_PROFILE,
  BUILT_IN_LENS_SLOTS,
  BUILT_IN_LENSES,
} from '../lens/lens-built-ins.ts'
import { builtInWorkflowCatalogue } from '../workflow/workflow-built-ins.ts'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    )
  return value
}

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
      JSON.stringify(
        canonical({
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
      ),
    )
    .digest('hex')
}

export const RECORD_BUILT_INS_IDENTITY = builtInsIdentity({
  lenses: BUILT_IN_LENSES,
  lensSlots: BUILT_IN_LENS_SLOTS,
  lensDefaultProfile: BUILT_IN_LENS_DEFAULT_PROFILE,
  workflows: builtInWorkflowCatalogue(),
})
