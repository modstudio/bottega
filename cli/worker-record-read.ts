// concern: confined worker CLI record reads
/** Routes the three run-scoped worker reads through the host ask server before stores load. */

import { PLATFORM_SLUG } from '../shared/brand.ts'
import { classifyCaller } from '../shared/caller-classification.ts'

type JsonObject = Record<string, unknown>

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function normalizedDocument(document: JsonObject): JsonObject {
  const number = Number(document.number)
  const key = String(document.task_key)
  return {
    id: document.id,
    number,
    label: `${key}/${number}`,
    task_key: key,
    task_record_id: document.task_id ?? '',
    role: document.role ?? null,
    title: document.title,
    updated_at: document.updated_at,
    body: document.body,
    version: document.version,
    created_at: document.created_at,
  }
}

function normalizedTask(detail: JsonObject): JsonObject {
  const task = detail.task as JsonObject
  return {
    task: {
      record_id: task.id,
      external_id: null,
      key: task.key,
      project: task.project,
      project_record_id: task.projectId ?? null,
      title: task.title,
      status: task.status,
      status_category: task.status_category,
      parent_key: task.parent_key,
      parent_record_id: task.parent_id ?? null,
      body: task.body,
      assignee: task.assignee,
      opened_at: task.opened_at,
      closed_at: task.closed_at,
      updated_at: task.updated_at,
      source: task.source,
      first_seen: task.first_seen,
      last_seen: task.last_seen,
      next_document_number: task.next_document_number,
      retired_reason: task.retired_reason ?? null,
      ...(task.revision === undefined ? {} : { revision: task.revision }),
    },
    comments: (detail.comments as JsonObject[]).map((comment) => ({
      id: comment.id,
      task_key: comment.task_key,
      task_record_id: comment.task_id ?? '',
      body: comment.body,
      created_at: comment.created_at,
      actor_user_id: comment.actor_user_id ?? null,
      actor_name: comment.actor_name ?? null,
      agent: comment.agent ?? null,
      run_id: comment.run_id ?? null,
      updated_at: comment.updated_at,
      deleted_at: comment.deleted_at,
      ...(comment.revision === undefined ? {} : { revision: comment.revision }),
    })),
    documents: (detail.documents as JsonObject[]).map(normalizedDocument),
  }
}

function workerReadRoute(argv: readonly string[]): 'task' | 'document' | 'workflow' | null {
  if (argv[0] === 'task' && argv[1] === 'show') return 'task'
  if (argv[0] === 'task' && argv[1] === 'doc' && argv[2] === 'show') return 'document'
  if (argv[0] === 'workflow' && argv[1] === 'text' && argv[2] === 'show') return 'workflow'
  return null
}

/** Return null when the normal CLI owner should handle this invocation. */
export async function dispatchWorkerRecordRead(argv: string[]): Promise<number | null> {
  const route = workerReadRoute(argv)
  if (
    !route ||
    classifyCaller(process.env).kind !== 'worker' ||
    !process.env.BOTTEGA_ASK_URL?.trim()
  )
    return null
  try {
    const [{ printShownTask, printShownTaskDocument }, { callWorkerRecordRead }] =
      await Promise.all([
        import('../hub/src/task-cli.ts'),
        import('../orchestrator/src/ask/worker-record-read-client.ts'),
      ])
    const json = argv.includes('--json')
    const value = route === 'task' ? argv[2] : argv[3]
    if (!value || value.startsWith('-')) throw new Error(`missing ${route} reference`)
    if (argv.includes('--fresh'))
      throw new Error("worker record scope is read-only; '--fresh' is outside that scope")
    if (option(argv, '--project') === '') throw new Error('--project requires a value')
    if (route === 'task') {
      const shown = normalizedTask(
        (await callWorkerRecordRead('read_task', { key: value })) as JsonObject,
      )
      if (json) console.log(JSON.stringify(shown))
      else printShownTask(shown as Parameters<typeof printShownTask>[0])
    } else if (route === 'document') {
      const document = normalizedDocument(
        (await callWorkerRecordRead('read_task_document', { reference: value })) as JsonObject,
      )
      if (json) console.log(JSON.stringify(document))
      else
        printShownTaskDocument(document as Parameters<typeof printShownTaskDocument>[0])
    } else {
      const id = value.replace(/^attached-text:/, '')
      const shown = (await callWorkerRecordRead('read_workflow_text', { id })) as JsonObject
      if (json) console.log(JSON.stringify(shown))
      else if (shown.kind === 'live') console.log(String(shown.body))
      else
        console.log(
          `${PLATFORM_SLUG} task document ${String(shown.documentReference)} preserves attached-text:${String(shown.id)}; read it with: ${PLATFORM_SLUG} task doc show ${String(shown.documentReference)}`,
        )
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
