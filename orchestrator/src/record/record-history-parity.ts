// concern: workflow-history record parity decision
/** Classifies local workflow-history rows absent from the hosted record. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideHistoryUploadPass, type HistoryUploadFingerprint } from './record-history-upload.ts'
import type {
  HostedRowPresence,
  HostedRowReferences,
  HostedRowTable,
} from './record-hosted-row-presence.ts'

export const WORKFLOW_HISTORY_PARITY_TABLES = [
  'workflow_step_text',
  'workflow_text_copy',
  'question_mutation_audit',
  'task_flow',
  'workflow_cursor',
] as const satisfies readonly HostedRowTable[]

type ParityTable = (typeof WORKFLOW_HISTORY_PARITY_TABLES)[number]
type ParityIds = Record<ParityTable, ReadonlySet<string>>
type LocalStates = {
  workflow_cursor: ReadonlyMap<string, string>
  task_flow: ReadonlyMap<string, string>
}

export type WorkflowHistoryParityInput = {
  local: ParityIds
  present: Pick<HostedRowPresence, ParityTable>
  references: HostedRowReferences
  heldFlowIds: ReadonlySet<string>
  heldQuestionIds: ReadonlySet<string>
  storedFingerprint: HistoryUploadFingerprint | null
  currentFingerprint: HistoryUploadFingerprint
  states: LocalStates
}

export type WorkflowHistoryParityDiagnosis = { lines: string[]; failed: boolean }

function flowForRow(
  table: ParityTable,
  id: string,
  references: HostedRowReferences,
): string | undefined {
  if (table === 'task_flow') return id
  if (table === 'workflow_cursor') return references.cursorFlow.get(id)
  if (table === 'workflow_step_text')
    return references.cursorFlow.get(references.stepTextCursor.get(id) ?? '')
  if (table === 'workflow_text_copy')
    return references.cursorFlow.get(references.textCopyCursor.get(id) ?? '')
  const question = references.auditQuestion.get(id)
  const cursor = question ? references.questionCursor.get(question) : undefined
  return cursor ? references.cursorFlow.get(cursor) : undefined
}

function rowIsHeld(table: ParityTable, id: string, input: WorkflowHistoryParityInput): boolean {
  if (table === 'question_mutation_audit') {
    const question = input.references.auditQuestion.get(id)
    if (question && input.heldQuestionIds.has(question)) return true
  }
  const flow = flowForRow(table, id, input.references)
  return flow !== undefined && input.heldFlowIds.has(flow)
}

function causeLine(counts: { held: number; skipped: number; pending: number }): string {
  return (
    `  causes: held ${counts.held} (no command clears this yet); ` +
    `skipped ${counts.skipped} (no command clears this yet); ` +
    `pending ${counts.pending} (run \`${PLATFORM_SLUG} record sync\`)`
  )
}

function stateLine(
  table: 'workflow_cursor' | 'task_flow',
  ids: readonly string[],
  states: LocalStates,
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
    const missing = [...local].filter((id) => !input.present[table].has(id))
    lines.push(
      `workflow history ${table}: ${local.size} local; ${local.size - missing.length} on the record — ${missing.length ? 'missing from the record' : 'ok'}`,
    )
    if (!missing.length) continue
    failed = true
    const counts = { held: 0, skipped: 0, pending: 0 }
    for (const id of missing) {
      if (rowIsHeld(table, id, input)) counts.held += 1
      else if (skipped) counts.skipped += 1
      else counts.pending += 1
    }
    lines.push(causeLine(counts))
    if (table === 'workflow_cursor' || table === 'task_flow')
      lines.push(stateLine(table, missing, input.states))
  }
  return { lines, failed }
}
