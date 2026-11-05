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

export const RECORD_BUILT_INS_IDENTITY = createHash('sha256')
  .update(
    JSON.stringify(
      canonical({
        lenses: BUILT_IN_LENSES,
        lensSlots: JSON.parse(BUILT_IN_LENS_SLOTS),
        lensDefaultProfile: JSON.parse(BUILT_IN_LENS_DEFAULT_PROFILE),
        workflows: (() => {
          const catalogue = builtInWorkflowCatalogue()
          return {
            stepCatalogue: {
              ...catalogue.stepCatalogue,
              definition: JSON.parse(catalogue.stepCatalogue.definition),
            },
            workflows: catalogue.workflows.map((workflow) => ({
              ...workflow,
              definition: JSON.parse(workflow.definition),
            })),
          }
        })(),
      }),
    ),
  )
  .digest('hex')
