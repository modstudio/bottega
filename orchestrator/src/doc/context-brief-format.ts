// concern: context brief formatting
/** Pure formatting decisions for in-flight context brief entries. */

import { isAbsolute, relative, sep } from 'node:path'

export type ContextBriefCursorLine = {
  number: number
  key: string | null
  workflow: string
  mode: string
  step: number
  totalSteps: number
  stepSlug: string
  branch: string | null
  worktree: string | null
  tip: string | null
  pr: number | null
  questionNumber: number | null
  runs: number[]
}

type ContextBriefRunLine = {
  number: number
  job: string
  status: string
  label: string | null
}

/** Show a worktree relative to its registered main checkout only when it is truly beneath it. */
export function contextBriefWorktreePath(worktree: string, mainCheckout: string | null): string {
  if (!mainCheckout) return worktree
  const offset = relative(mainCheckout, worktree)
  const beneath =
    offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  return beneath ? offset || '.' : worktree
}

/** Render one task-bound cursor with only the handles that exist. */
export function formatContextBriefCursorLine(cursor: ContextBriefCursorLine): string {
  const identity = [
    `cursor ${cursor.number}`,
    cursor.key,
    cursor.workflow,
    cursor.mode,
    `step ${cursor.step}/${cursor.totalSteps}`,
    cursor.stepSlug,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
  const handles = [
    cursor.branch ? `branch ${cursor.branch}` : null,
    cursor.worktree ? `worktree ${cursor.worktree}` : null,
    cursor.tip ? `tip ${cursor.tip}` : null,
    cursor.pr === null ? null : `pr ${cursor.pr}`,
  ].filter((handle): handle is string => handle !== null)
  const question = cursor.questionNumber === null ? '' : `, awaiting q${cursor.questionNumber}`
  const runs = cursor.runs.length ? `, runs ${cursor.runs.join(', ')}` : ''
  return [identity, ...handles].join(' · ') + question + runs
}

/** Render one unbound run with its optional single-line label. */
export function formatContextBriefRunLine(run: ContextBriefRunLine): string {
  const label = run.label?.replace(/\s+/g, ' ').trim()
  return `unbound run ${run.number} ${run.job} ${run.status}${label ? ` · ${label}` : ''}`
}
