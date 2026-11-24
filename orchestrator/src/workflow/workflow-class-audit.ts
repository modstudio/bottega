// concern: workflows
/** Pure class-audit decision over cursor, promotion, and implement-run facts. */

export type ClassAuditClosedStep = {
  slug: string
  evidence?: Array<{ flag: string; value: string }>
}
export type ClassAuditCursor = {
  number: number
  recordId: string
  project: string
  workflow: string
  key: string
  taskRecordId: string | null
  createdAt: string
  closed: readonly ClassAuditClosedStep[]
}
export type ClassAuditImplementRun = {
  cursorRecordId: string | null
  taskRecordId: string | null
  startedAt: string
}

const promotionKey = (project: string, key: string) => `${project}\0${key}`

function carriesClassMeasurement(step: ClassAuditClosedStep): boolean {
  if (step.slug !== 'measure-class') return false
  const flags = new Set((step.evidence ?? []).map((entry) => entry.flag))
  return ['--class', '--command', '--exec', '--count'].every((flag) => flags.has(flag))
}

export function auditUnmeasuredDefectCursors(input: {
  since: string
  cursors: readonly ClassAuditCursor[]
  promoted: readonly Array<{ project: string; key: string }>
  implementRuns: readonly ClassAuditImplementRun[]
}): { count: number; cursors: Array<{ number: number; workflow: string; key: string }> } {
  const promoted = new Set(input.promoted.map((entry) => promotionKey(entry.project, entry.key)))
  const cursors = input.cursors.filter((cursor) => {
    if (cursor.createdAt < input.since) return false
    if (!promoted.has(promotionKey(cursor.project, cursor.key))) return false
    if (cursor.closed.some(carriesClassMeasurement)) return false
    if (cursor.workflow === 'fix-defect')
      return cursor.closed.some((step) => step.slug === 'implement-fix')
    if (cursor.workflow !== 'plan-task') return false
    return input.implementRuns.some(
      (run) =>
        run.cursorRecordId === cursor.recordId ||
        (cursor.taskRecordId !== null &&
          run.taskRecordId === cursor.taskRecordId &&
          run.startedAt >= cursor.createdAt),
    )
  })
  return {
    count: cursors.length,
    cursors: cursors.map(({ number, workflow, key }) => ({ number, workflow, key })),
  }
}
