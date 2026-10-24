// concern: workflows
/** Decides where a finished workflow child's evidence row is written. Must not run children or touch the store. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CONNECTION_SCHEMA_INVARIANT,
  type InFlightMigrationCompatibility,
} from '../database/migration-compatibility.ts'

/**
 * What an operator does about evidence this process could not record, defined once
 * because both refusals below end with it.
 */
const RECORD_AGAIN_REMEDY = `cleared by: re-run the command under ${PLATFORM_SLUG} workflow exec once the store and checkout agree`

export type WorkflowEvidenceRecordingDecision =
  | { action: 'record' }
  | { action: 'hand-off' }
  | { action: 'refuse'; reason: string }

/**
 * A child may migrate the store after this process opened it. Recording in-process
 * is safe when the versions agree, when this process never opened the store, or
 * when every migration between them is marked additive — the last case reloads the
 * schema instead of refusing, which is why exec enables schema reload.
 *
 * An incompatible forward range belongs to a process that opens the migrated store
 * itself. A store behind the opened version cannot be trusted either way.
 */
export function decideWorkflowEvidenceRecording(input: {
  /** The store's user_version this process opened, or null when it never opened the store. */
  openedSchemaVersion: number | null
  /** The store's user_version after the child exited, or null when it was not read. */
  storeSchemaVersion: number | null
  /**
   * The journal compatibility of the range, from `inFlightMigrationCompatibility`. Asked
   * only when the store moved forward, so equal versions never read the journal.
   */
  compatibility: () => InFlightMigrationCompatibility
}): WorkflowEvidenceRecordingDecision {
  if (input.openedSchemaVersion === null) return { action: 'record' }
  if (input.storeSchemaVersion === null) return { action: 'hand-off' }
  if (input.storeSchemaVersion === input.openedSchemaVersion) return { action: 'record' }
  if (input.storeSchemaVersion < input.openedSchemaVersion)
    return {
      action: 'refuse',
      reason:
        `refusing ${PLATFORM_SLUG} workflow exec evidence: the store is behind the schema this process opened ` +
        `(store user_version ${input.storeSchemaVersion}, opened ${input.openedSchemaVersion})\n` +
        `invariant: ${CONNECTION_SCHEMA_INVARIANT}\n` +
        RECORD_AGAIN_REMEDY,
    }
  return input.compatibility() === 'additive' ? { action: 'record' } : { action: 'hand-off' }
}

/**
 * A hand-off that recorded nothing is evidence lost, not the wrapped command's own
 * verdict, so its message leads with the wrapped command's exit code.
 */
export function workflowEvidenceNotRecordedRefusal(input: {
  exitCode: number
  detail?: string | null
}): string {
  const detail = input.detail ? ` (${input.detail})` : ''
  return (
    `${PLATFORM_SLUG} workflow exec: command exited ${input.exitCode}; its evidence was not recorded${detail}\n` +
    RECORD_AGAIN_REMEDY
  )
}
