// concern: workflow-history record parity decision
/** Classifies local workflow-history rows absent from the hosted record. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideHistoryUploadPass, type HistoryUploadFingerprint } from './record-history-upload.ts'
import {
  type HostedRowHeldIds,
  type HostedRowPresence,
  type HostedRowReferences,
  type HostedRowStates,
  type HostedRowTable,
  hostedRowIsHeld,
  questionAuditIsPresent,
} from './record-hosted-row-presence.ts'

const WORKFLOW_HISTORY_PARITY_TABLES = [
  'workflow_step_text',
  'workflow_text_copy',
  'question_mutation_audit',
  'task_flow',
  'workflow_cursor',
] as const satisfies readonly HostedRowTable[]

type ParityTable = (typeof WORKFLOW_HISTORY_PARITY_TABLES)[number]
type ParityIds = Record<ParityTable, ReadonlySet<string>>
type ParityPresence = Pick<HostedRowPresence, ParityTable | 'questionAuditIdentities'>
type CauseCounts = { held: number; skipped: number; pending: number }

export type WorkflowHistoryParityInput = {
  local: ParityIds
  present: ParityPresence
  references: HostedRowReferences
  held: HostedRowHeldIds
  storedFingerprint: HistoryUploadFingerprint | null
  currentFingerprint: HistoryUploadFingerprint
  states: HostedRowStates
}

export type WorkflowHistoryParityDiagnosis = { lines: string[]; failed: boolean }

function heldWarningLine(table: ParityTable, count: number): string {
  return `  warning: workflow history ${table}: held ${count} (no command clears this yet)`
}

function causeLine(counts: Pick<CauseCounts, 'skipped' | 'pending'>): string {
  return (
    `  causes: skipped ${counts.skipped} (run \`${PLATFORM_SLUG} machine update\`, then \`${PLATFORM_SLUG} record sync\`); ` +
    `pending ${counts.pending} (run \`${PLATFORM_SLUG} record sync\`)`
  )
}

function rowIsPresent(table: ParityTable, id: string, input: WorkflowHistoryParityInput): boolean {
  if (table !== 'question_mutation_audit') return input.present[table].has(id)
  return questionAuditIsPresent(id, input.references.auditIdentity.get(id), input.present)
}

function classifyMissingRows(
  table: ParityTable,
  input: WorkflowHistoryParityInput,
  skipped: boolean,
): { ids: string[]; counts: CauseCounts } {
  const ids = [...input.local[table]].filter((id) => !rowIsPresent(table, id, input))
  const counts = { held: 0, skipped: 0, pending: 0 }
  for (const id of ids) {
    if (hostedRowIsHeld(table, id, input.references, input.held)) counts.held += 1
    else if (skipped) counts.skipped += 1
    else counts.pending += 1
  }
  return { ids, counts }
}

function tableStatus(
  missing: number,
  actionable: number,
): 'ok' | 'held locally' | 'missing from the record' {
  if (missing === 0) return 'ok'
  return actionable === 0 ? 'held locally' : 'missing from the record'
}

function stateLine(
  table: 'workflow_cursor' | 'task_flow',
  ids: readonly string[],
  states: HostedRowStates,
) {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const state = states[table].get(id) ?? 'unknown'
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const split = [...counts].sort(([left], [right]) => left.localeCompare(right))
  return `  local states: ${split.map(([state, count]) => `${state} ${count}`).join(', ')}`
}

/** Decide the visible parity report from already-collected local and hosted facts. */
export function workflowHistoryParityDiagnosis(
  input: WorkflowHistoryParityInput,
): WorkflowHistoryParityDiagnosis {
  const lines: string[] = []
  let failed = false
  const skipped =
    decideHistoryUploadPass({
      stored: input.storedFingerprint,
      current: input.currentFingerprint,
    }) === 'skip'

  for (const table of WORKFLOW_HISTORY_PARITY_TABLES) {
    const local = input.local[table]
    const { ids: missing, counts } = classifyMissingRows(table, input, skipped)
    const actionable = counts.skipped + counts.pending
    lines.push(
      `workflow history ${table}: ${local.size} local; ${local.size - missing.length} on the record — ${tableStatus(missing.length, actionable)}`,
    )
    if (!missing.length) continue
    if (counts.held > 0) lines.push(heldWarningLine(table, counts.held))
    if (actionable > 0) {
      failed = true
      lines.push(causeLine(counts))
    }
    if (table === 'workflow_cursor' || table === 'task_flow')
      lines.push(stateLine(table, missing, input.states))
  }
  return { lines, failed }
}
