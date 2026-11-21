// concern: context-service
/** Owns context item reads and mutations over the document store. */
import type { Database } from 'bun:sqlite'
import {
  type ContextHolderKind,
  type ContextItemKind,
  splitContextHolder,
} from '../../../shared/context-item-vocabulary.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { db, sessionId, writableDb } from '../database/db.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { openKeylessCursorsForSession } from '../workflow/workflow-cursor-list.ts'
import type { HubTaskReference } from '../workflow/workflow-task-reference.ts'
import { contextCursorWarning } from './context-cursor-warning-decision.ts'
import { hostedContextItemClient } from './context-item-hosted-client.ts'
import {
  getContextItem,
  listContextHolders,
  listContextItems,
  removeLocalContextHolder,
  removeLocalContextItem,
  setLocalContextItem,
} from './context-item-store.ts'
import {
  assertContextDropAllowed,
  assertContextSetAllowed,
  contextCursorOwner,
  lookupContextTask,
  resolveContextTaskWithChildren,
  resolvedPointerTarget,
  taskProfile,
} from './context-write-adapter.ts'
import {
  type ContextTaskIdentity,
  ContextWriteRefusalError,
  holderOwnershipRefusal,
} from './doc-context-write.ts'
import { contextTaskOwner } from './doc-hosted-client.ts'
import { cursorContextHolder, taskContextHolder } from './doc-subjects.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'

export type ContextHolderSelection = { task?: string; session?: string; cursor?: string }

type ResolvedContextHolder = {
  holder: string
  task: ContextTaskIdentity | null
  children: HubTaskReference[]
}

type CursorTask = { project: string; taskKey: string | null }
type TaskParent = { key: string; project: string; parent_key?: string | null }

async function cachedCursorTask(
  cache: Map<string, TaskParent | null>,
  project: string,
  key: string,
  lookup: (project: string, key: string) => Promise<TaskParent | null>,
): Promise<TaskParent | null> {
  const scopedKey = `${project}\0${key}`
  if (cache.has(scopedKey)) return cache.get(scopedKey) ?? null
  const task = await lookup(project, key)
  cache.set(scopedKey, task)
  return task
}

/** Read only the ancestor chains needed to decide whether an open cursor carries a task. */
export async function cursorAncestorTasks(input: {
  task: { key: string; project: string }
  openCursors: readonly CursorTask[]
  lookup(project: string, key: string): Promise<TaskParent | null>
}): Promise<TaskParent[]> {
  if (
    input.openCursors.some(
      (cursor) => cursor.project === input.task.project && cursor.taskKey === input.task.key,
    )
  )
    return []

  const cache = new Map<string, TaskParent | null>()
  const tasks = new Map<string, TaskParent>()
  for (const cursor of input.openCursors) {
    if (cursor.project !== input.task.project || !cursor.taskKey) continue
    let key: string | null = cursor.taskKey
    const visited = new Set<string>()
    while (key && !visited.has(key)) {
      visited.add(key)
      if (key === input.task.key) return [...tasks.values()]
      const scopedKey = `${cursor.project}\0${key}`
      const task = await cachedCursorTask(cache, cursor.project, key, input.lookup)
      if (!task) break
      tasks.set(scopedKey, task)
      key = task.parent_key ?? null
    }
  }
  return [...tasks.values()]
}

async function resolveContextHolder(
  selection: ContextHolderSelection,
): Promise<ResolvedContextHolder> {
  if (selection.task && selection.session) throw new Error('use --task or --session, not both')
  if (selection.cursor && (selection.task || selection.session))
    throw new Error('select exactly one context holder')
  if (selection.cursor)
    return { holder: cursorContextHolder(selection.cursor), task: null, children: [] }
  if (selection.task) {
    const resolved = await resolveContextTaskWithChildren(selection.task)
    return {
      holder: taskContextHolder(resolved.task.record_id),
      task: resolved.task,
      children: resolved.children,
    }
  }
  const owner = selection.session ?? sessionId()
  if (!owner) throw new Error('no caller session; pass --task KEY or --session ID')
  return { holder: `session:${owner}`, task: null, children: [] }
}

async function taskCursorWarning(task: ContextTaskIdentity): Promise<string | null> {
  try {
    const cursors = await taskFlowReadStore(db()).listOpenStages({ project: task.project })
    const openCursors = cursors.map((cursor) => ({
      project: cursor.project,
      taskKey: cursor.workflow_key || null,
    }))
    const cursorAncestors = await cursorAncestorTasks({
      task,
      openCursors,
      lookup: lookupContextTask,
    })
    return contextCursorWarning({
      task,
      tasks: cursorAncestors,
      openCursors,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `warning: cursor check unavailable: ${withholdSecretShapedDetail(detail)}; the item was written, and rerunning the same context set once the store answers repeats the check`
  }
}

export async function getContext(selection: ContextHolderSelection) {
  const { holder, task, children } = await resolveContextHolder(selection)
  const profile = task ? taskProfile(task.key, children) : 'session'
  const cursors = selection.session
    ? await openKeylessCursorsForSession(selection.session, db())
    : []
  const addresses = [holder, ...cursors.map((cursor) => cursorContextHolder(cursor.record_id))]
  const batchedItems = await listContextItems(addresses)
  const items = batchedItems.filter((item) => item.holder === holder)
  const cursorHolders = cursors.map((cursor) => {
    const cursorHolder = cursorContextHolder(cursor.record_id)
    return {
      cursor: cursor.number,
      project: cursor.project,
      workflow: cursor.workflow_slug,
      mode: cursor.mode_slug,
      holder: cursorHolder,
      items: batchedItems.filter((item) => item.holder === cursorHolder),
    }
  })
  return {
    holder,
    task: task?.key ?? null,
    profile,
    items,
    cursorHolders,
  }
}

/** Reads one item's current revision on a resolved holder for compare-and-set writes. */
export async function contextItemRevision(
  selection: ContextHolderSelection & { id: string },
): Promise<string | undefined> {
  const { holder } = await resolveContextHolder(selection)
  return (await getContextItem(holder, selection.id))?.revision
}

export async function sessionContextItems(session: string, database: Database) {
  const holder = `session:${session}`
  return listContextItems(holder, database)
}

/** Removes every item on a task holder; a whole-holder clear is not blocked by required kinds. */
export async function clearTaskContext(input: { task: string }) {
  assertWorkerDocStoreWriteAllowed('clearTaskContext')
  const { holder, task } = await resolveContextHolder(input)
  if (!task) throw new Error('task context clear requires --task')
  const result = await clearTaskHolderForLifecycle({
    holderId: task.record_id,
    project: task.project,
    dryRun: false,
  })
  return {
    holder,
    task: task.key,
    removed: result.removed,
    alreadyAbsent: result.alreadyAbsent,
  }
}

/** Clears one task holder by durable identity for lifecycle cleanup. */
export async function clearTaskHolderForLifecycle(input: {
  holderId: string
  project: string
  dryRun: boolean
}) {
  assertWorkerDocStoreWriteAllowed('clearTaskHolderForLifecycle')
  const holder = taskContextHolder(input.holderId)
  const items = await listContextItems(holder)
  if (input.dryRun) return { holder, removed: items.length, alreadyAbsent: 0 }
  writableDb()
  const result = await applyRecordWriteAuthority({
    local: () => ({ removed: removeLocalContextHolder(holder), alreadyAbsent: 0 }),
    hosted: async () => {
      const client = await hostedContextItemClient(
        holder,
        contextTaskOwner({ project: input.project }),
      )
      let removed = 0
      let alreadyAbsent = 0
      for (const item of items) {
        const hosted = await client.remove(item.recordId, { expectedRevision: item.revision })
        if (hosted.removed) removed++
        else alreadyAbsent++
      }
      return { removed, alreadyAbsent }
    },
  })
  return { holder, ...result }
}

/** Lists one scope of stored context through the context service read boundary. */
export async function scopeContextHolders(
  holderKind: ContextHolderKind,
  database: Database = db(),
) {
  return (await listContextHolders(holderKind, database)).map(
    ({ holder, holderId, updatedAt, items }) => ({
      holder,
      holderId,
      updatedAt,
      items,
    }),
  )
}

export async function sessionContextHolders(database: Database) {
  return (await scopeContextHolders('session', database)).map(
    ({ holder, holderId, updatedAt, items }) => ({
      holder,
      session: holderId,
      updatedAt,
      items,
    }),
  )
}

/** Hosted lifecycle removal is unconditional like task clearing; the selected record revision guards against a changed item. */
async function dropSessionContextItemForLifecycle(input: {
  session: string
  id: string
  localExpectedRevision: string
  reason: string
}) {
  assertWorkerDocStoreWriteAllowed('dropSessionContextItemForLifecycle')
  const holder = `session:${input.session}`
  writableDb()
  const item = await getContextItem(holder, input.id)
  if (!item) return { holder, id: input.id, outcome: 'already-absent' as const }
  const result = await applyRecordWriteAuthority({
    local: () =>
      removeLocalContextItem(holder, input.id, input.localExpectedRevision)
        ? ('dropped' as const)
        : ('already-absent' as const),
    hosted: async () => {
      if (item.revision !== input.localExpectedRevision)
        throw new Error(
          `context item ${holder}/${input.id} changed since it was selected\n` +
            'remedy: retry the lifecycle operation',
        )
      const sessionOwner = db()
        .query<{ project: string | null }, [string]>(
          'SELECT project FROM presence WHERE session_id=?',
        )
        .get(input.session)
      const runOwner = sessionOwner?.project?.trim()
        ? null
        : db()
            .query<{ project: string | null }, [string]>(
              `SELECT project.name AS project
               FROM run JOIN project ON project.record_id=run.project_record_id
               WHERE run.session_id=? ORDER BY run.number DESC LIMIT 1`,
            )
            .get(input.session)
      const project = sessionOwner?.project?.trim() || runOwner?.project?.trim()
      if (!project)
        throw new Error(
          `session ${input.session} has no recorded owning project\n` +
            'remedy: restore the session registry row with its owning project, then retry the lifecycle operation',
        )
      const client = await hostedContextItemClient(holder, {
        kind: 'session',
        checkoutProject: project,
      })
      const hosted = await client.remove(item.recordId, { expectedRevision: item.revision })
      return hosted.removed ? ('dropped' as const) : ('already-absent' as const)
    },
  })
  return { holder, id: input.id, outcome: result }
}

type SessionContextDropOutcome = 'dropped' | 'already-absent' | 'would-drop' | 'failed'

export type SessionContextDropResult = {
  item: Awaited<ReturnType<typeof sessionContextItems>>[number]
  outcome: SessionContextDropOutcome
  error: string | null
}

/** The single lifecycle loop for dropping selected items from one session holder. */
export async function dropSessionContextItemsForLifecycle(input: {
  session: string
  items: Awaited<ReturnType<typeof sessionContextItems>>
  reason: string
  dryRun?: boolean
}): Promise<SessionContextDropResult[]> {
  const results: SessionContextDropResult[] = []
  for (const item of input.items) {
    if (item.revision === null) {
      results.push({
        item,
        outcome: 'failed',
        error: 'context item revision is unavailable',
      })
      continue
    }
    if (input.dryRun) {
      results.push({ item, outcome: 'would-drop', error: null })
      continue
    }
    try {
      const result = await dropSessionContextItemForLifecycle({
        session: input.session,
        id: item.id,
        localExpectedRevision: item.revision,
        reason: input.reason,
      })
      results.push({
        item,
        outcome: result.outcome,
        error: null,
      })
    } catch (error) {
      results.push({
        item,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function setContextItem(
  input: ContextHolderSelection & {
    id: string
    kind: ContextItemKind
    source: string
    body: string
    expectedRevision?: string
  },
) {
  assertWorkerDocStoreWriteAllowed('setContextItem')
  const { holder, task, children } = await resolveContextHolder(input)
  writableDb()
  const questionNumber = /^(?:q)(\d+)$/.exec(input.source.trim())
  const item = {
    holder,
    id: input.id,
    kind: input.kind,
    source: input.source,
    body: input.body,
    questionNumber:
      ['ruling', 'position'].includes(input.kind) && questionNumber
        ? Number(questionNumber[1])
        : null,
    target: null as string | null,
  }
  // Ownership is refused before pointer resolution reads git or a task tracker for the caller.
  const ownership = holderOwnershipRefusal(
    holder,
    sessionId(),
    input.id,
    (await contextCursorOwner(holder))?.session_id,
  )
  if (ownership) throw new ContextWriteRefusalError(ownership)
  if (input.kind === 'pointer') item.target = await resolvedPointerTarget(input.body)
  await assertContextSetAllowed(
    task ? { holder, item, contextTask: task, contextTaskChildren: children } : { holder, item },
  )
  const localInput = {
    holder,
    slug: input.id,
    kind: input.kind,
    body: input.body,
    source: input.source,
    questionNumber: item.questionNumber,
    target: item.target,
    expectedRevision: input.expectedRevision,
  }
  const written = await applyRecordWriteAuthority({
    local: () => setLocalContextItem(localInput),
    hosted: async () => {
      const current = await getContextItem(holder, input.id)
      const client = await hostedContextItemClient(holder, contextTaskOwner(task ?? undefined))
      const address = splitContextHolder(holder)
      const result = await client.upsert({
        id: current?.recordId,
        holderKind: address.holderKind,
        holderId: address.holderId,
        slug: input.id,
        kind: input.kind,
        body: input.body,
        source: input.source,
        questionNumber: item.questionNumber,
        target: item.target,
        expectedRevision: input.expectedRevision,
      })
      return {
        ...item,
        recordId: result.id,
        revision: result.updatedAt,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      }
    },
  })
  const warning = task ? await taskCursorWarning(task) : null
  return {
    task: task?.key ?? null,
    holder: written.holder,
    id: written.id,
    kind: written.kind,
    source: written.source,
    body: written.body,
    revision: written.revision,
    warning,
  }
}

export async function dropContextItem(
  input: ContextHolderSelection & {
    id: string
    expectedRevision?: string
  },
) {
  assertWorkerDocStoreWriteAllowed('dropContextItem')
  const { holder, task } = await resolveContextHolder(input)
  writableDb()
  const item = await getContextItem(holder, input.id)
  if (!item)
    return {
      holder,
      task: task?.key ?? null,
      id: input.id,
      removed: false,
      alreadyAbsent: true,
    }
  await assertContextDropAllowed({ item })
  const result = await applyRecordWriteAuthority({
    local: () => ({
      removed: removeLocalContextItem(holder, input.id, input.expectedRevision),
      alreadyAbsent: false,
    }),
    hosted: async () => {
      const client = await hostedContextItemClient(holder, contextTaskOwner(task ?? undefined))
      const result = await client.remove(item.recordId, {
        expectedRevision: input.expectedRevision,
      })
      return {
        removed: result.removed,
        alreadyAbsent: !result.removed,
      }
    },
  })
  return { holder, task: task?.key ?? null, id: input.id, ...result }
}
