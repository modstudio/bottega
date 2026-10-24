// concern: workflows
/** Runs the installation's own binary to record evidence this process must not write. Must not decide when. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  encodeWorkflowEvidencePayload,
  RECORD_EVIDENCE_FLAG,
  type WorkflowEvidencePayload,
} from './workflow-evidence-payload.ts'

export type WorkflowEvidenceHandOff =
  | { kind: 'recorded'; id: number; withheld: boolean }
  | { kind: 'not-recorded'; detail: string | null }

/**
 * This process must not write the row, so it asks the installation's own entry to: the
 * seam `shared/self-spawn.ts` resolves that entry for the checkout, the shim layout and
 * the compiled binary alike, whose copy is the checkout the child may have just pulled.
 * It asks for the receiver's JSON so the row's withheld flag travels back with the id,
 * and leaves the receiver's stderr on this process's stderr. The receiver's failure and
 * the id it does not print are the only detail this reports; the payload is never echoed.
 *
 * This adapter stays untested by choice: its failure announces itself as a non-zero
 * receiver, a missing id or a spawn that cannot start, and the caller reports every
 * one of those as evidence not recorded against the wrapped command's own exit code.
 */
export function handOffWorkflowEvidence(payload: WorkflowEvidencePayload): WorkflowEvidenceHandOff {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(
      [...bottegaEntryArgv(PLATFORM_SLUG), 'workflow', 'exec', RECORD_EVIDENCE_FLAG, '--json'],
      {
        env: process.env,
        stdin: Buffer.from(encodeWorkflowEvidencePayload(payload)),
        stdout: 'pipe',
        stderr: 'inherit',
      },
    )
  } catch (error) {
    return { kind: 'not-recorded', detail: error instanceof Error ? error.message : String(error) }
  }
  if (result.exitCode !== 0) return { kind: 'not-recorded', detail: null }
  let printed: unknown
  try {
    printed = JSON.parse((result.stdout ?? '').toString().trim())
  } catch {
    return { kind: 'not-recorded', detail: 'the receiving process printed no id' }
  }
  const record =
    typeof printed === 'object' && printed !== null ? (printed as Record<string, unknown>) : null
  if (typeof record?.id !== 'number')
    return { kind: 'not-recorded', detail: 'the receiving process printed no id' }
  return { kind: 'recorded', id: record.id, withheld: record.withheld === true }
}
