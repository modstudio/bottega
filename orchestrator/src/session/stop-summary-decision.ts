// concern: session stop summary decision
/** Turns session facts into the bounded summary shown at Stop. */

import { createHash } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const OWED_ITEM_OVERDUE_MS = 60 * 60 * 1000

type StopSummaryCursor = {
  key: string | null
  workflow: string
  step: string
  ordinal: number
  total: number
}

export type StopSummaryOwedItem = {
  label: string
  command: string
  owedAt: string
}

export type StopSummaryNote = {
  label: string
  command: string
}

export type StopSummaryFacts = {
  now: string
  questionCount: number
  cursors: StopSummaryCursor[]
  liveRuns: number
  incompleteReviews: number
  inFlightLandings: number
  owedItems: StopSummaryOwedItem[]
  notes: StopSummaryNote[]
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

const owedLine = (item: StopSummaryOwedItem) => `${item.label} → ${item.command}`
const noteLine = (item: StopSummaryNote) => `${item.label} → ${item.command}`

function blockKey(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

function cursorLine(cursor: StopSummaryCursor): string {
  const owner = cursor.key ? `${cursor.key} · ${cursor.workflow}` : cursor.workflow
  return `${owner} · step ${cursor.step} (${cursor.ordinal} of ${cursor.total})`
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
  const lines = [
    facts.questionCount
      ? `${count(facts.questionCount, 'question')} waiting on you → ${PLATFORM_SLUG} question inbox`
      : 'Nothing waiting on you',
    ...facts.cursors.map(cursorLine),
  ]
  const moving = movingLine(facts)
  if (moving) lines.push(moving)

  const now = Date.parse(facts.now)
  const overdue = facts.owedItems.filter(
    (item) => Number.isFinite(now) && now - Date.parse(item.owedAt) >= OWED_ITEM_OVERDUE_MS,
  )
  const owedBlockKey = facts.owedItems.length ? blockKey(facts.owedItems.map(owedLine)) : null
  if (moving) {
    lines.push(...overdue.map(owedLine))
    lines.push(...facts.notes.map(noteLine))
    return { lines, block: false, reason: null, blockKey: owedBlockKey }
  }
  if (!facts.owedItems.length) {
    lines.push(...facts.notes.map(noteLine))
    return { lines, block: false, reason: null, blockKey: null }
  }

  const detailed = facts.owedItems.map(owedLine)
  const notes = facts.notes.map(noteLine)
  const reason = [...lines, ...detailed, ...notes].join('\n')
  if (facts.previousBlockKey === owedBlockKey) {
    lines.push(`${count(facts.owedItems.length, 'item')} owed → ${PLATFORM_SLUG} score pending`)
    lines.push(...notes)
    return { lines, block: false, reason, blockKey: owedBlockKey }
  }
  lines.push(...detailed, ...notes)
  return { lines, block: true, reason, blockKey: owedBlockKey }
}
