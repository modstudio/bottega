// concern: context-review
/** Gathers timed context-review facts, records due reviews, and renders their prompt. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { splitContextHolder } from '../../../shared/context-item-vocabulary.ts'
import { db } from '../database/db.ts'
import { contextBrief } from '../doc/context-brief.ts'
import type { StoredContextItem } from '../doc/context-item-store.ts'
import { cursorContextHolder, taskContextHolder } from '../doc/doc-subjects.ts'
import { listWorkflowCursors } from '../workflow/workflow-cursor-list.ts'
import { readHubTasks } from '../workflow/workflow-task-reference.ts'
import {
  CONTEXT_REVIEW_WINDOW_MS,
  type ContextReviewFacts,
  type ContextReviewOrderedItem,
  decideContextReview,
  taskHoldersCarriedByOpenCursors,
} from './context-review-decision.ts'
import { recordContextReview } from './context-review-store.ts'

type ReviewHolder = {
  key: string
  holder: string
  kind: 'session' | 'cursor' | 'task'
}

export type ContextReviewResult =
  | { next_due_at: string }
  | {
      due: true
      next_due_at: string
      interval_ms: number
      review: string
      items: number
      flagged: number
    }

function compactionGaps(database: Database, now: number) {
  const rows = database
    .query<{ session_id: string; at: string }, []>(
      "SELECT session_id,at FROM brief_injection WHERE source='compact' ORDER BY session_id,at",
    )
    .all()
  const previous = new Map<string, number>()
  return rows.flatMap((row) => {
    const at = Date.parse(row.at)
    const before = previous.get(row.session_id)
    previous.set(row.session_id, at)
    return before !== undefined && at >= now - CONTEXT_REVIEW_WINDOW_MS
      ? [{ at, gapMs: at - before }]
      : []
  })
}

function latestAt(
  database: Database,
  table: 'context_review' | 'brief_injection',
  session: string,
) {
  const statement =
    table === 'context_review'
      ? 'SELECT MAX(at) at FROM context_review WHERE session_id=?'
      : 'SELECT MAX(at) at FROM brief_injection WHERE session_id=?'
  const row = database.query<{ at: string | null }, [string]>(statement).get(session)
  return row?.at ? Date.parse(row.at) : null
}

function sessionStartedAt(database: Database, session: string, now: number): number {
  const row = database
    .query<{ at: string | null }, [string]>(
      'SELECT MIN(at) at FROM hook_emission WHERE session_id=?',
    )
    .get(session)
  return row?.at ? Date.parse(row.at) : now
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function selector(holder: string, holders: readonly ReviewHolder[]): string {
  const reference = holders.find((candidate) => candidate.holder === holder)
  if (!reference) throw new Error(`context review holder ${holder} is not in the brief`)
  if (reference.kind === 'session') return `--session ${shellQuote(reference.key)}`
  if (reference.kind === 'cursor') return `--cursor ${shellQuote(reference.key)}`
  return `--task ${shellQuote(reference.key)}`
}

function holderLabel(holder: string, holders: readonly ReviewHolder[]): string {
  const reference = holders.find((candidate) => candidate.holder === holder)
  if (!reference) return holder
  return reference.kind === 'task' ? reference.key : `${reference.kind}:${reference.key}`
}

function itemLine(
  item: ContextReviewOrderedItem,
  holders: readonly ReviewHolder[],
  now: number,
): string {
  const selected = selector(item.holder, holders)
  const ageMinutes = Math.max(0, Math.floor((now - item.updatedAt) / 60_000))
  const reason = item.reason ?? 'not flagged'
  const revise = `${PLATFORM_SLUG} agent context set ${selected} --kind ${item.kind} --source ${shellQuote('context-review')} --id ${shellQuote(item.id)} '<revised body>'`
  const drop = `${PLATFORM_SLUG} agent context drop ${selected} --id ${shellQuote(item.id)}`
  return `${item.flagged ? 'FLAGGED ' : ''}${holderLabel(item.holder, holders)} ${item.id} ${item.kind} ${ageMinutes}m · ${reason}\n  revise: ${revise}\n  drop: ${drop}`
}

function renderContextReview(
  intervalMs: number,
  items: readonly ContextReviewOrderedItem[],
  holders: readonly ReviewHolder[],
  now: number,
): string {
  const flagged = items.filter((item) => item.flagged).length
  const lines = [
    `Context review (every ${Math.round(intervalMs / 60_000)}m): ${flagged} of ${items.length} items flagged; revise or drop each that is no longer true.`,
    ...items.map((item) => itemLine(item, holders, now)),
  ]
  return lines.join('\n')
}

export async function reviewContext(
  session: string,
  dependencies: { database?: Database; now?: () => number } = {},
): Promise<ContextReviewResult> {
  const database = dependencies.database ?? db(true)
  const now = (dependencies.now ?? Date.now)()
  const [brief, cursors] = await Promise.all([
    contextBrief(session, process.cwd(), database),
    listWorkflowCursors({ session }, database),
  ])
  const projects = [...new Set(cursors.map((cursor) => cursor.project))]
  const tasks = (await Promise.all(projects.map(readHubTasks))).flat()
  const holders: ReviewHolder[] = brief.holders.flatMap((holder) => {
    const address = holder.items[0]?.holder
    if (!address) return []
    const { holderKind, holderId } = splitContextHolder(address)
    return [
      {
        key: holderKind === 'task' ? holder.key : holderId,
        holder: address,
        kind: holderKind,
      },
    ]
  })
  const taskByKey = new Map(tasks.map((task) => [`${task.project}\0${task.key}`, task]))
  const openCursors = cursors.flatMap((cursor) => {
    const holder = cursor.workflow_key
      ? taskByKey.get(`${cursor.project}\0${cursor.workflow_key}`)?.record_id
      : cursor.record_id
    return holder
      ? [
          {
            holder: cursor.workflow_key ? taskContextHolder(holder) : cursorContextHolder(holder),
            stepStartedAt: Date.parse(cursor.updated_at),
          },
        ]
      : []
  })
  const items = brief.holders.flatMap((holder) =>
    (holder.items as StoredContextItem[]).map((item) => ({
      recordId: item.recordId,
      id: item.id,
      kind: item.kind,
      holder: item.holder,
      updatedAt: Date.parse(item.updatedAt),
      body: item.body,
    })),
  )
  const facts: ContextReviewFacts = {
    now,
    sessionStartedAt: sessionStartedAt(database, session, now),
    lastReviewAt: latestAt(database, 'context_review', session),
    lastBriefInjectionAt: latestAt(database, 'brief_injection', session),
    compactionGaps: compactionGaps(database, now),
    items,
    openCursors,
    carriedTaskHolders: taskHoldersCarriedByOpenCursors(
      cursors.map((cursor) => ({
        project: cursor.project,
        taskKey: cursor.workflow_key || null,
      })),
      tasks,
    ),
    doneTaskKeys: tasks.filter((task) => task.status_category === 'done').map((task) => task.key),
  }
  const decision = decideContextReview(facts)
  const flagged = decision.items.filter((item) => item.flagged).length
  if (!decision.due)
    return {
      next_due_at: new Date(decision.nextDueAt).toISOString(),
    }
  const event = recordContextReview(
    {
      sessionId: session,
      intervalMs: decision.intervalMs,
      items: decision.items.length,
      flagged,
      itemIds: decision.items.map((item) => item.recordId),
    },
    { database },
  )
  const nextDueAt = new Date(Date.parse(event.at) + decision.intervalMs).toISOString()
  if (decision.items.length === 0) return { next_due_at: nextDueAt }
  const review = renderContextReview(decision.intervalMs, decision.items, holders, now)
  return {
    due: true,
    next_due_at: nextDueAt,
    interval_ms: decision.intervalMs,
    review,
    items: decision.items.length,
    flagged,
  }
}
