// concern: context-health
/** Pure policy for judging stored architect context from already gathered facts. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextItemKind } from '../../../shared/context-item-vocabulary.ts'
import { contextCursorWarning } from '../doc/context-cursor-warning-decision.ts'
import { CONTEXT_ITEM_MAX_CHARS } from '../doc/doc-context-write.ts'
import { STALE_REFERENCE_RULES } from '../doc/doc-lint.ts'
import { isOpenStageState } from '../record/record-task-flow-contract.ts'
import { CONTEXT_REVIEW_WINDOW_MS } from '../session/context-review-decision.ts'
import { nearestRankPercentile } from '../state/statistics.ts'

const CONTEXT_HEALTH_WRONG_EXIT_CODE = 2
const CONTEXT_HEALTH_UNREACHABLE_EXIT_CODE = 1

export type ContextHealthItem = {
  holder: string
  holderId: string
  holderKind: 'task' | 'session' | 'cursor'
  id: string
  recordId: string
  kind: ContextItemKind
  body: string
  updatedAt: string
  project: string | null
  taskKey: string | null
  taskStatus: string | null
  referenceFindings: Array<{ rule: string; message: string }>
  unverifiable: string | null
  projectRegistered: boolean
}

type ContextHealthCursorStage = {
  recordId: string
  project: string
  taskKey: string | null
  state: string
}

export type ContextHealthFacts = {
  now: string
  since: string
  items: ContextHealthItem[]
  tasks: Array<{ key: string; project: string; parent_key?: string | null }>
  cursorStages: ContextHealthCursorStage[]
  liveRunCursorIds: string[]
  reviews: Array<{ sessionId: string; at: string; items: number; flagged: number }>
  briefs: Array<{
    sessionId: string
    at: string
    source: string
    cursors: number
    overCap: boolean
  }>
  unreachable: { resource: string; detail: string; remedy: string } | null
}

export type ContextHealthFinding = ContextHealthItem & {
  ageMs: number
  size: number
  cap: number
  remedy: string
  staleReferences: ContextHealthItem['referenceFindings']
}

export type ContextHealthReport = {
  verdict: 'healthy' | 'wrong' | 'unreachable'
  exitCode: 0 | 1 | 2
  since: string
  generatedAt: string
  unreachable: ContextHealthFacts['unreachable']
  signals: {
    s1: ContextHealthFinding[]
    s2: ContextHealthFinding[]
    s3: ContextHealthFinding[]
    s4: ContextHealthFinding[]
    s5: ContextHealthFinding[]
    s6: Array<{ sessionId: string; reviews: number; items: number }>
    s7: Array<{
      sessionId: string
      compactBriefs: number
      zeroCursorBriefs: number
      zeroCursorShare: number
      overCapBriefs: number
      overCapShare: number
    }>
    s8: ContextHealthFinding[]
  }
  s1Projects: Array<{ project: string; items: number }>
  aging: {
    count: number
    minimumMs: number | null
    medianMs: number | null
    maximumMs: number | null
  }
  notMeasured: Array<{ criterion: string; missing: string }>
}

const NOT_MEASURED = [
  {
    criterion: 'DEV-1844 criterion 1 (ordered writes per verb)',
    missing: "item revision order isn't readable",
  },
  {
    criterion: 'DEV-1844 criterion 3 (brief includes every worked task)',
    missing: 'brief_injection carries no worked-task signal',
  },
  { criterion: 'Use', missing: 'nothing records whether a loaded item was acted on' },
  { criterion: 'Near-duplicates', missing: 'embedding comparison is held for slice 2' },
] as const

function ageMs(item: ContextHealthItem, now: number): number {
  return Math.max(0, now - Date.parse(item.updatedAt))
}

function remedy(item: ContextHealthItem): string {
  if (item.taskKey) return `${PLATFORM_SLUG} agent context clear --task ${item.taskKey}`
  if (item.holderKind === 'task')
    return `context item ${item.id} is held by task holder ${item.holderId} whose task no longer resolves; no verb clears it yet (note 01a1f05d)`
  const holderFlag = item.holderKind === 'session' ? '--session' : '--cursor'
  const selector = `${holderFlag} ${item.holderId}`
  return `${PLATFORM_SLUG} agent context drop ${selector} --id ${item.id}`
}

function finding(item: ContextHealthItem, now: number): ContextHealthFinding {
  return {
    ...item,
    unverifiable:
      item.unverifiable ??
      (item.project !== null && !item.projectRegistered
        ? `item names project ${item.project}, which is not a registered project`
        : null),
    ageMs: ageMs(item, now),
    size: item.body.length,
    cap: CONTEXT_ITEM_MAX_CHARS[item.kind],
    remedy: remedy(item),
    staleReferences: item.referenceFindings.filter(({ rule }) => isStaleContextReference(rule)),
  }
}

function reachedContextCursors(
  stages: readonly ContextHealthCursorStage[],
  liveRunCursorIds: readonly string[],
) {
  const live = new Set(liveRunCursorIds)
  return stages
    .filter((stage) => isOpenStageState(stage.state) || live.has(stage.recordId))
    .map(({ project, taskKey }) => ({ project, taskKey }))
}

function isStaleContextReference(rule: string): boolean {
  return STALE_REFERENCE_RULES.has(rule) && rule !== 'doc/line-anchor'
}

function reviewBlind(reviews: ContextHealthFacts['reviews']) {
  return [...Map.groupBy(reviews, (row) => row.sessionId)].flatMap(([sessionId, rows]) =>
    rows.length && rows.every((row) => row.flagged === 0 && row.items > 0)
      ? [{ sessionId, reviews: rows.length, items: rows.reduce((sum, row) => sum + row.items, 0) }]
      : [],
  )
}

function compactionBriefs(briefs: ContextHealthFacts['briefs']) {
  const compact = briefs.filter((row) => row.source === 'compact')
  return [...Map.groupBy(compact, (row) => row.sessionId)].map(([sessionId, rows]) => {
    const zeroCursorBriefs = rows.filter((row) => row.cursors === 0).length
    const overCapBriefs = rows.filter((row) => row.overCap).length
    return {
      sessionId,
      compactBriefs: rows.length,
      zeroCursorBriefs,
      zeroCursorShare: zeroCursorBriefs / rows.length,
      overCapBriefs,
      overCapShare: overCapBriefs / rows.length,
    }
  })
}

function s1ProjectCounts(items: ContextHealthFinding[]) {
  return [...Map.groupBy(items, (item) => item.project!)].map(([project, projectItems]) => ({
    project,
    items: projectItems.length,
  }))
}

export function contextHealth(facts: ContextHealthFacts): ContextHealthReport {
  const now = Date.parse(facts.now)
  const emptySignals = { s1: [], s2: [], s3: [], s4: [], s5: [], s6: [], s7: [], s8: [] }
  if (facts.unreachable) {
    return {
      verdict: 'unreachable',
      exitCode: CONTEXT_HEALTH_UNREACHABLE_EXIT_CODE,
      since: facts.since,
      generatedAt: facts.now,
      unreachable: facts.unreachable,
      signals: emptySignals,
      s1Projects: [],
      aging: { count: 0, minimumMs: null, medianMs: null, maximumMs: null },
      notMeasured: [...NOT_MEASURED],
    }
  }
  const withFinding = (items: ContextHealthItem[]) => items.map((item) => finding(item, now))
  const openCursors = reachedContextCursors(facts.cursorStages, facts.liveRunCursorIds)
  const s1 = withFinding(
    facts.items.filter(
      (item) =>
        item.taskKey &&
        item.project &&
        contextCursorWarning({
          task: { key: item.taskKey, project: item.project },
          openCursors,
          tasks: facts.tasks,
        }) !== null,
    ),
  )
  const s2 = withFinding(facts.items.filter((item) => item.taskStatus === 'done'))
  const s3 = withFinding(
    facts.items.filter((item) => item.body.length > CONTEXT_ITEM_MAX_CHARS[item.kind]),
  )
  const duplicateKeys = new Map<string, Set<string>>()
  for (const item of facts.items) {
    const key = item.body.toLowerCase().replace(/\s+/g, ' ').trim()
    const holders = duplicateKeys.get(key) ?? new Set<string>()
    holders.add(item.holder)
    duplicateKeys.set(key, holders)
  }
  const s4 = withFinding(
    facts.items.filter(
      (item) =>
        (duplicateKeys.get(item.body.toLowerCase().replace(/\s+/g, ' ').trim())?.size ?? 0) > 1,
    ),
  )
  const live = facts.items.filter((item) => item.taskStatus !== 'done')
  const agingItems = live.filter(
    (item) =>
      (item.kind === 'fact' || item.kind === 'pointer') &&
      ageMs(item, now) > CONTEXT_REVIEW_WINDOW_MS,
  )
  const s5 = withFinding(agingItems)
  const s6 = reviewBlind(facts.reviews)
  const s7 = compactionBriefs(facts.briefs)
  const s8 = withFinding(
    live.filter(
      (item) =>
        item.referenceFindings.some(({ rule }) => isStaleContextReference(rule)) ||
        item.unverifiable !== null ||
        (item.project !== null && !item.projectRegistered),
    ),
  )
  const ages = live
    .filter((item) => item.kind === 'fact' || item.kind === 'pointer')
    .map((item) => ageMs(item, now))
    .sort((a, b) => a - b)
  const signals = { s1, s2, s3, s4, s5, s6, s7, s8 }
  const s1Projects = s1ProjectCounts(s1)
  const wrong = s1.length + s2.length + s3.length + s4.length > 0
  return {
    verdict: wrong ? 'wrong' : 'healthy',
    exitCode: wrong ? CONTEXT_HEALTH_WRONG_EXIT_CODE : 0,
    since: facts.since,
    generatedAt: facts.now,
    unreachable: null,
    signals,
    s1Projects,
    aging: {
      count: ages.length,
      minimumMs: nearestRankPercentile(ages, 0),
      medianMs: nearestRankPercentile(ages, 0.5),
      maximumMs: nearestRankPercentile(ages, 1),
    },
    notMeasured: [...NOT_MEASURED],
  }
}
