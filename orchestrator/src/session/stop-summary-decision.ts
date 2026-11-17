// concern: session stop summary decision
/** Turns session facts into the bounded summary shown at Stop. */

import { createHash } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { QuestionInboxCounts } from '../run/question-inbox-counts.ts'
import { workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import { KEYLESS_CURSOR_IDLE_MS, keylessCursorIdle } from './keyless-cursor-idle.ts'
import { formatStopTime } from './stop-summary-time.ts'

export const OWED_ITEM_OVERDUE_MS = 60 * 60 * 1000

type StopSummaryCursor = {
  number: number
  project: string
  key: string | null
  workflow: string
  step: string
  ordinal: number
  total: number
  updatedAt: string
  questionNumber: number | null
}

export type StopSummaryOwedItem = {
  kind: string
  noun: string
  qualifier: string | null
  id: string
  command: string
  owedAt: string
  openFindings?: number
}

export type StopSummaryFacts = {
  now: string
  displayTimezone?: string | null
  questionCounts: QuestionInboxCounts | null
  cursors: StopSummaryCursor[]
  reviewVerdictLines: string[]
  liveRuns: number
  incompleteReviews: number
  inFlightLandings: number
  owedItems: StopSummaryOwedItem[]
  previousBlockKey: string | null
}

export type StopSummaryDecision = {
  lines: string[]
  block: boolean
  reason: string | null
  blockKey: string | null
}

const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`

type OwedGroup = {
  kind: string
  noun: string
  qualifier: string | null
  command: string
  ids: string[]
  openFindings: number
}

function owedGroups(items: readonly StopSummaryOwedItem[]): OwedGroup[] {
  const groups = new Map<string, OwedGroup>()
  for (const item of items) {
    const key = `${item.kind}\0${item.qualifier ?? ''}`
    const existing = groups.get(key)
    if (existing) {
      existing.ids.push(item.id)
      existing.openFindings += item.openFindings ?? 0
      continue
    }
    groups.set(key, {
      kind: item.kind,
      noun: item.noun,
      qualifier: item.qualifier,
      command: item.command,
      ids: [item.id],
      openFindings: item.openFindings ?? 0,
    })
  }
  return [...groups.values()]
}

function owedLine(group: OwedGroup): string {
  const qualifier = group.qualifier ? ` (${group.qualifier})` : ''
  const findings = group.openFindings ? ` (${count(group.openFindings, 'finding')} open)` : ''
  return `${count(group.ids.length, group.noun)}${qualifier}${findings}: ${group.ids.join(', ')} → ${group.command}`
}

function blockKey(items: readonly StopSummaryOwedItem[]): string {
  const identities = items.map((item) => `${item.kind}\0${item.id}`).sort()
  return createHash('sha256').update(identities.join('\n')).digest('hex')
}

function cursorLine(cursor: StopSummaryCursor): string {
  const owner = cursor.key ? `${cursor.key} · ${cursor.workflow}` : cursor.workflow
  return `${owner} · step ${cursor.step} (${cursor.ordinal} of ${cursor.total})`
}

function idleCursorLine(cursor: StopSummaryCursor, now: number): string | null {
  if (cursor.key || cursor.questionNumber !== null) return null
  const idle = keylessCursorIdle(cursor.updatedAt, now)
  if (!idle || idle.ms < KEYLESS_CURSOR_IDLE_MS) return null
  return `${cursor.workflow} cursor ${cursor.number} ${idle.label} → ${PLATFORM_SLUG} workflow abandon${workflowCursorReference(cursor.number, cursor.project).cli}`
}

function movingLine(facts: StopSummaryFacts): string | null {
  const parts = [
    facts.liveRuns ? count(facts.liveRuns, 'run') : null,
    facts.incompleteReviews ? count(facts.incompleteReviews, 'review round') : null,
    facts.inFlightLandings ? count(facts.inFlightLandings, 'landing') : null,
  ].filter((part): part is string => part !== null)
  return parts.length ? `In progress: ${parts.join(', ')}` : null
}

export function decideStopSummary(facts: StopSummaryFacts): StopSummaryDecision {
  const questionLines = facts.questionCounts
    ? [
        facts.questionCounts.worker
          ? `${count(facts.questionCounts.worker, 'worker question')} for this session → ${PLATFORM_SLUG} question inbox`
          : null,
        facts.questionCounts.user
          ? `${count(facts.questionCounts.user, 'ruling')} waiting on you → ${PLATFORM_SLUG} question inbox`
          : null,
      ].filter((line): line is string => line !== null)
    : [`Could not read question inbox → ${PLATFORM_SLUG} question inbox --all --active`]
  if (facts.questionCounts && !questionLines.length) questionLines.push('Nothing waiting on you')
  const lines = [
    `${formatStopTime(facts.now, facts.displayTimezone)}`,
    ...questionLines,
    ...facts.cursors.map(cursorLine),
    ...facts.cursors
      .map((cursor) => idleCursorLine(cursor, Date.parse(facts.now)))
      .filter((line): line is string => line !== null),
    ...facts.reviewVerdictLines,
  ]
  const moving = movingLine(facts)
  if (moving) lines.push(moving)

  const now = Date.parse(facts.now)
  const overdue = facts.owedItems.filter(
    (item) => Number.isFinite(now) && now - Date.parse(item.owedAt) >= OWED_ITEM_OVERDUE_MS,
  )
  const owedBlockKey = facts.owedItems.length ? blockKey(facts.owedItems) : null
  if (moving) {
    lines.push(...owedGroups(overdue).map(owedLine))
    return { lines, block: false, reason: null, blockKey: owedBlockKey }
  }
  if (!facts.owedItems.length) {
    return { lines, block: false, reason: null, blockKey: null }
  }

  const detailed = owedGroups(facts.owedItems).map(owedLine)
  const reason = [...lines, ...detailed].join('\n')
  if (facts.previousBlockKey === owedBlockKey) {
    lines.push(`${count(facts.owedItems.length, 'item')} owed → ${PLATFORM_SLUG} score pending`)
    return { lines, block: false, reason, blockKey: owedBlockKey }
  }
  lines.push(...detailed)
  return { lines, block: true, reason, blockKey: owedBlockKey }
}
