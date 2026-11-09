// concern: context-service
/** Gathers and renders the compact architect context brief. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { listClaims } from '../board/board-claim-service.ts'
import { claimNotices } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { architectSessionContext } from '../workflow/session-context.ts'
import { listWorkflowCursors } from '../workflow/workflow-cursor-list.ts'
import { readHubTasks } from '../workflow/workflow-task-reference.ts'
import { decodeContextItem } from './context-item-codec.ts'
import type { ContextItem, ContextItemKind } from './doc-context-write.ts'
import { listDocsStore } from './doc-read-store.ts'
import { listOpenResumes } from './docs.ts'

type ContextBriefHolder = {
  key: string
  title: string
  kind: 'session' | 'task' | 'epic'
  items: ContextItem[]
}

export type ContextBrief = {
  session: string
  fullCommand: string
  holders: ContextBriefHolder[]
  runs: Array<{ number: number; job: string; status: string }>
  cursors: Array<{
    number: number
    workflow: string
    state: string
    questionNumber: number | null
  }>
  claims: Array<{ kind: string; value: string }>
  waiting: { boardRequests: number; questions: number; resumeBriefs: number }
  autonomy: string
}

const ITEM_ORDER: readonly ContextItemKind[] = [
  'next-action',
  'ruling',
  'position',
  'fact',
  'open-question',
  'pointer',
]

const firstLine = (body: string) => body.split(/\r?\n/, 1)[0]!.trim()
const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`

function renderItem(item: ContextItem): string {
  const label =
    item.kind === 'next-action'
      ? 'next'
      : item.kind === 'open-question'
        ? 'open'
        : item.kind === 'ruling'
          ? `ruling ${item.source}`
          : item.kind
  const body = firstLine(item.body)
  return `  ${label}: ${item.kind === 'ruling' ? JSON.stringify(body) : body}`
}

/** The fixed compact/resume layout; gathering facts is deliberately separate. */
export function renderContextBrief(brief: ContextBrief): string {
  const lines = [`Context (session ${brief.session}) · full: ${brief.fullCommand}`]
  for (const holder of brief.holders) {
    lines.push(
      holder.kind === 'session'
        ? `Session ${holder.key}`
        : `${holder.key} ${holder.title}`.trimEnd(),
    )
    const items = holder.items.toSorted(
      (left, right) =>
        ITEM_ORDER.indexOf(left.kind) - ITEM_ORDER.indexOf(right.kind) ||
        left.id.localeCompare(right.id),
    )
    for (const item of items) lines.push(renderItem(item))
    if (!items.some((item) => item.kind === 'open-question')) lines.push('  open: none')
  }
  const inFlight = [
    ...brief.runs.map((run) => `run ${run.number} ${run.job} ${run.status}`),
    ...brief.cursors.map((cursor) =>
      cursor.questionNumber === null
        ? `cursor ${cursor.number} ${cursor.workflow} ${cursor.state}`
        : `cursor ${cursor.number} ${cursor.workflow}, awaiting q${cursor.questionNumber}`,
    ),
    ...brief.claims.map((claim) => `claim ${claim.kind}:${claim.value}`),
  ]
  lines.push(`In flight: ${inFlight.join(' · ') || 'none'}`)
  lines.push(
    `Waiting: ${count(brief.waiting.boardRequests, 'board request')} (${PLATFORM_SLUG} board read) · ` +
      `${count(brief.waiting.questions, 'question')} · ` +
      `${count(brief.waiting.resumeBriefs, 'resume brief')} (${PLATFORM_SLUG} doc resumes)`,
  )
  lines.push(`Autonomy: ${brief.autonomy}`)
  return lines.join('\n')
}

type Task = {
  key: string
  project: string
  title?: string | null
  parent_key?: string | null
}

function storedItems(holder: string, database: Database): ContextItem[] {
  return listDocsStore({ scope: 'context', subject: holder }, database).map((doc) =>
    decodeContextItem(holder, doc.slug, doc.body),
  )
}

function holderSequence(session: string, working: string[], tasks: Task[], database: Database) {
  const holders: ContextBriefHolder[] = []
  const sessionItems = storedItems(`session:${session}`, database)
  if (sessionItems.length)
    holders.push({ key: session, title: '', kind: 'session' as const, items: sessionItems })
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const emitted = new Set<string>()
  const add = (key: string, kind: 'task' | 'epic') => {
    if (emitted.has(key)) return
    const task = byKey.get(key)
    if (!task) return
    emitted.add(key)
    holders.push({
      key,
      title: task.title ?? '',
      kind,
      items: storedItems(`task:${key}`, database),
    })
  }
  for (const key of working.toSorted()) {
    const task = byKey.get(key)
    if (!task) continue
    add(key, task.parent_key ? 'task' : 'epic')
    let parent = task.parent_key ?? null
    while (parent) {
      add(parent, 'epic')
      parent = byKey.get(parent)?.parent_key ?? null
    }
  }
  return holders
}

function autonomyLine(context: Awaited<ReturnType<typeof architectSessionContext>>): string {
  if (!context.registered) return 'unknown'
  const grouped: Array<{ value: string; stages: string[] }> = []
  for (const stage of context.stages) {
    const value = stage.agreed ? stage.value : 'mixed'
    const existing = grouped.find((item) => item.value === value)
    if (existing) existing.stages.push(stage.stage)
    else grouped.push({ value, stages: [stage.stage] })
  }
  return [
    ...grouped.map((item) => `${item.stages.join(', ')} ${item.value}`),
    `ship ${context.shipTo.value}`,
  ].join(' · ')
}

export async function contextBrief(
  session: string,
  cwd = process.cwd(),
  database: Database = db(),
): Promise<ContextBrief> {
  const tasks = (await readHubTasks(PLATFORM_SLUG)) as Task[]
  const cursors = listWorkflowCursors({ session }, database)
  const project = tasks.find((task) => task.project === PLATFORM_SLUG)?.project ?? PLATFORM_SLUG
  const claims = listClaims(project, false)
    .claims.filter((claim) => claim.holder === session)
    .map((claim) => claim.subject)
  const working = [
    ...claims.filter((claim) => claim.kind === 'task').map((claim) => claim.value),
    ...cursors.map((cursor) => cursor.workflow_key).filter(Boolean),
  ]
  const runs = database
    .query(
      `SELECT number,job,status FROM run
       WHERE session_id=? AND status IN ('reserved','attached','running','asking') ORDER BY number`,
    )
    .all(session) as ContextBrief['runs']
  const runQuestions = database
    .query(
      `SELECT COUNT(*) count FROM question q JOIN run r ON r.record_id=q.run_record_id
       WHERE r.session_id=? AND ${questionOpenSql('q')}`,
    )
    .get(session) as { count: number }
  const cursorQuestions = database
    .query(
      `SELECT COUNT(*) count FROM question q JOIN workflow_cursor c
       ON c.record_id=q.workflow_cursor_record_id WHERE c.session_id=? AND ${questionOpenSql('q')}`,
    )
    .get(session) as { count: number }
  const boardEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: session }
  const boardRequests = claimNotices(true, boardEnv, Date.now(), database).filter(
    (notice) => notice.purpose === 'request',
  ).length
  const holders = holderSequence(session, [...new Set(working)], tasks, database)
  const fullHolder = holders.find((holder) => holder.kind !== 'session')
  const autonomy = await architectSessionContext(cwd, { database })
  return {
    session,
    fullCommand: fullHolder
      ? `${PLATFORM_SLUG} agent context show --task ${fullHolder.key}`
      : `${PLATFORM_SLUG} agent context show --session ${session}`,
    holders,
    runs,
    cursors: cursors.map((cursor) => ({
      number: cursor.id,
      workflow: cursor.workflow_slug,
      state: cursor.state,
      questionNumber: cursor.question_number,
    })),
    claims,
    waiting: {
      boardRequests,
      questions: runQuestions.count + cursorQuestions.count,
      resumeBriefs: listOpenResumes(cwd).open.length,
    },
    autonomy: autonomyLine(autonomy),
  }
}
