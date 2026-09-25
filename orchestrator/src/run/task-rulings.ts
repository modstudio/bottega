// concern: task-rulings
/** Knows which prior task rulings are carried and how they render. Must not know databases or dispatch. */

import type { AnswererKind } from './question-vocabulary.ts'

const TASK_RULINGS_MAX_COUNT = 20
const TASK_RULINGS_MAX_BYTES = 8192

export type TaskRulingRow = {
  question_id: number
  run_id: number
  project: string | null
  launch_key: string | null
  question: string
  answer: string
  answered_at: string
  answerer_kind: AnswererKind | null
  overturned_at: string | null
  replacement: string | null
}

type CarriedTaskRuling = {
  questionId: number
  runId: number
  question: string
  ruling: string
  ruledBy: 'operator' | 'agent'
  date: string
  replacement: boolean
}

export type TaskRulingsSelection = {
  rulings: CarriedTaskRuling[]
  omitted: number
}

function carriedRuling(row: TaskRulingRow): CarriedTaskRuling | null {
  if (row.overturned_at && row.replacement === null) return null
  return {
    questionId: row.question_id,
    runId: row.run_id,
    question: row.question,
    ruling: row.replacement ?? row.answer,
    ruledBy: row.answerer_kind === 'operator' ? 'operator' : 'agent',
    date: (row.replacement ? row.overturned_at : row.answered_at)!.slice(0, 10),
    replacement: row.replacement !== null,
  }
}

function entryText(ruling: CarriedTaskRuling): string {
  const replacement = ruling.replacement ? ' (replaces an overturned ruling)' : ''
  return (
    `- Question: ${ruling.question}\n` +
    `  Ruling${replacement}: ${ruling.ruling}\n` +
    `  Ruled by: ${ruling.ruledBy} · run ${ruling.runId} · ${ruling.date}`
  )
}

function sectionText(rulings: CarriedTaskRuling[], omitted: number): string {
  const lines = ['RULINGS ALREADY MADE ON THIS TASK', '', ...rulings.map(entryText)]
  if (omitted) lines.push('', `${omitted} older rulings omitted`)
  return lines.join('\n')
}

/** Select newest task rulings, then drop the oldest until both carry caps hold. */
export function selectTaskRulings(
  rows: TaskRulingRow[],
  project: string,
  launchKey: string,
  limits: { count?: number; bytes?: number } = {},
): TaskRulingsSelection {
  const count = limits.count ?? TASK_RULINGS_MAX_COUNT
  const bytes = limits.bytes ?? TASK_RULINGS_MAX_BYTES
  const eligible = rows
    .filter((row) => row.project === project && row.launch_key === launchKey)
    .toSorted((left, right) => right.answered_at.localeCompare(left.answered_at))
    .flatMap((row) => {
      const ruling = carriedRuling(row)
      return ruling ? [ruling] : []
    })
  const rulings = eligible.slice(0, count)
  let omitted = eligible.length - rulings.length
  while (rulings.length && Buffer.byteLength(sectionText(rulings, omitted), 'utf8') > bytes) {
    rulings.pop()
    omitted += 1
  }
  return { rulings, omitted }
}

export function renderTaskRulings(selection: TaskRulingsSelection): string {
  if (!selection.rulings.length && !selection.omitted) return ''
  return sectionText(selection.rulings, selection.omitted)
}
