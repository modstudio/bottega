// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { splitContextHolder } from '../../../shared/context-item-vocabulary.ts'
import { parsePointerReference } from '../../../shared/reference.ts'
import {
  referenceNotVisibleRefusal,
  referenceStoreUnreachableRefusal,
} from '../../../shared/reference-refusal.ts'
import { liveClaimsOfSession } from '../board/board-claim-service.ts'
import { db, sessionId } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { resolveParsedReference } from '../identity/identity.ts'
import { identityContext } from '../identity/identity-context.ts'
import { ResolutionMissError } from '../identity/identity-local-run.ts'
import { projectForTaskKey, projects, taskKeyPrefix } from '../project/projects.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  type HubTaskPuller,
  type HubTaskReference,
  pullHubTask,
  readHubTaskChildren,
  readHubTaskReference,
  readHubTaskReferenceByRecordId,
  resolveOrPullHubTaskReference,
  taskReadRefusal,
  taskRecordFailureNamesMissingTask,
} from '../workflow/workflow-task-reference.ts'
import { productionWorkflowTextDocumentPorts } from '../workflow/workflow-text-copy.ts'
import { listContextItems } from './context-item-store.ts'
import {
  type ContextItem,
  type ContextProfile,
  ContextWriteRefusalError,
  contextWriteRefusal,
  holderOwnershipRefusal,
} from './doc-context-write.ts'
import { readHostedDocReference } from './doc-hosted-client.ts'
import { isScratchLocation } from './doc-resume-write.ts'
import { taskContextHolder } from './doc-subjects.ts'

export type ContextTask = HubTaskReference
class ContextTaskPrefixError extends Error {
  readonly key: string
  readonly prefix: string

  constructor(key: string, prefix: string) {
    super(
      `task key prefix ${JSON.stringify(prefix)} is not declared by exactly one registered project; inspect prefixes with ${PLATFORM_SLUG} project list --json`,
    )
    this.name = 'ContextTaskPrefixError'
    this.key = key
    this.prefix = prefix
  }
}

export type ContextFactsPorts = {
  task: HubTaskPuller
  lookup(project: string, key: string): Promise<ContextTask | null>
  record(recordId: string): Promise<ContextTask | null>
  children(project: string, parent: string): Promise<ContextTask[]>
  pointer(value: string, database: Database): Promise<string | null>
}
export type PointerTargetPorts = {
  document(address: string): Promise<void>
  task(key: string, database: Database): Promise<ContextTask>
  taskDocument(pointer: string): Promise<string>
  commit(reference: string): string
}
export const CONTEXT_FACTS_PORTS_KEY = Symbol.for('orch.context-facts-ports')
const portsHolder = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

function recordedPullRequest(number: number, database: Database): boolean {
  return Boolean(
    database.query('SELECT 1 FROM pull_request_ci WHERE pr_number=? LIMIT 1').get(number),
  )
}

async function pointerRefusal(value: string, database: Database): Promise<string | null> {
  try {
    await resolvedPointerTarget(value, database)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function resolveTaskDocumentPointer(pointer: string): Promise<string> {
  const key = pointer.slice(0, pointer.indexOf('/'))
  try {
    const docs = await productionWorkflowTextDocumentPorts.list(key, PLATFORM_SLUG)
    if (docs.some((doc) => doc.reference === pointer)) return pointer
    throw new ContextWriteRefusalError(
      referenceNotVisibleRefusal(
        `task ${key}`,
        `pass a document number that \`${PLATFORM_SLUG} task doc list ${key}\` shows`,
      ),
    )
  } catch (error) {
    if (error instanceof ContextWriteRefusalError) throw error
    throw new Error(
      `task documents of ${key} could not be read (${(error as Error).message}); retry once the task store answers`,
    )
  }
}

async function resolveRunPointer(
  reference: Extract<ReturnType<typeof parsePointerReference>, { kind: 'run' }>,
  database: Database,
): Promise<string> {
  try {
    return (
      await resolveParsedReference(
        reference.reference,
        reference.source,
        identityContext(database),
        'run',
      )
    ).recordId
  } catch (error) {
    if (
      !(error instanceof ResolutionMissError) ||
      reference.explicit ||
      reference.reference.qualifier ||
      reference.reference.value.kind !== 'number'
    )
      throw error
    const number = reference.reference.value.number
    const pullRequest = recordedPullRequest(number, database)
    throw new ContextWriteRefusalError(
      pullRequest
        ? `${error.message}; pass #<n> for a pull request`
        : `${error.message}; for a commit, pass the full SHA`,
    )
  }
}

async function resolveDocPointer(address: string, ports: PointerTargetPorts): Promise<string> {
  try {
    await ports.document(address)
    return `doc:${address}`
  } catch (error) {
    if (
      (error instanceof RecordApiRequestError && error.status === 404) ||
      (error instanceof Error && /\b(?:not found|does not exist)\b/i.test(error.message))
    )
      throw new ContextWriteRefusalError(
        referenceNotVisibleRefusal('the document store', 'pass a visible doc reference'),
      )
    if (
      error instanceof RecordApiRequestError &&
      ((error.status !== null && error.status >= 400 && error.status < 500) ||
        error.kind === 'refused' ||
        error.kind === 'conflict')
    )
      throw new ContextWriteRefusalError(error.message)
    throw new Error(
      referenceStoreUnreachableRefusal(
        'the document store',
        error instanceof Error ? error.message : String(error),
      ),
    )
  }
}

async function resolveTaskPointer(
  parsed: Extract<ReturnType<typeof parsePointerReference>, { kind: 'task' | 'comment' }>,
  database: Database,
  ports: PointerTargetPorts,
): Promise<string> {
  const task = await ports.task(parsed.key, database)
  if (parsed.kind === 'comment' && task.commentsVerifiable === false)
    throw new ContextWriteRefusalError(
      `task:${parsed.key}#comment:${parsed.id} cannot be verified because this tracker's task read does not report comment ids; use task:${parsed.key}`,
    )
  if (parsed.kind === 'comment' && !task.commentIds?.map(String).includes(parsed.id))
    throw new ContextWriteRefusalError(
      referenceNotVisibleRefusal(`task ${parsed.key}`, 'pass a comment id on that task'),
    )
  return parsed.kind === 'task' ? `task:${task.key}` : `task:${task.key}#comment:${parsed.id}`
}

async function resolveStoredPointer(
  parsed: Extract<
    ReturnType<typeof parsePointerReference>,
    { kind: 'probe' | 'exec' | 'review-read' | 'attached-text' }
  >,
  pointer: string,
  database: Database,
): Promise<string> {
  const visible =
    parsed.kind === 'review-read'
      ? database.query('SELECT 1 FROM review_read WHERE record_id=?').get(parsed.recordId)
      : parsed.kind === 'attached-text'
        ? await taskFlowReadStore(database).textAttachmentByRecordId(parsed.recordId)
        : database
            .query('SELECT 1 FROM probe WHERE record_id=? AND kind=?')
            .get(parsed.recordId, parsed.kind)
  if (visible) return pointer
  throw new ContextWriteRefusalError(
    referenceNotVisibleRefusal('this machine', 'pass the UUID of a visible record'),
  )
}

/** Resolve the durable identity stored beside a pointer after the write gate accepts it. */
export async function resolvedPointerTarget(
  value: string,
  database: Database = db(),
  ports: PointerTargetPorts = {
    document: async (address) => {
      await readHostedDocReference(address)
    },
    task: async (key, targetDatabase) => {
      const { task } = await resolveContextTaskWithChildren(key, targetDatabase)
      return (await pullHubTask(task.project, key)) ?? task
    },
    taskDocument: resolveTaskDocumentPointer,
    commit: (reference) => resolveCommitArgument(process.cwd(), reference),
  },
): Promise<string> {
  const pointer = value.trim()
  // A pointer that cannot be a durable target is a policy refusal, not a retryable failure.
  if (!pointer) throw new ContextWriteRefusalError('pointer must not be empty')
  if (isScratchLocation(pointer))
    throw new ContextWriteRefusalError('scratch paths are not durable pointers')
  let parsed: ReturnType<typeof parsePointerReference>
  try {
    parsed = parsePointerReference(pointer)
  } catch (error) {
    throw new ContextWriteRefusalError(error instanceof Error ? error.message : String(error))
  }
  if (parsed.kind === 'task-document') return ports.taskDocument(`${parsed.key}/${parsed.number}`)
  if (parsed.kind === 'run') return resolveRunPointer(parsed, database)
  if (parsed.kind === 'commit') return ports.commit(parsed.sha)
  if (parsed.kind === 'pull-request') {
    const number = parsed.number
    if (number !== null && recordedPullRequest(number, database)) return String(number)
    throw new ContextWriteRefusalError(
      referenceNotVisibleRefusal(
        'this project',
        `no pull request #${number} is recorded for this project; check the number`,
      ),
    )
  }
  if (parsed.kind === 'doc') return resolveDocPointer(parsed.address, ports)
  if (parsed.kind === 'task' || parsed.kind === 'comment')
    return resolveTaskPointer(parsed, database, ports)
  return resolveStoredPointer(parsed, pointer, database)
}

const productionContextFactsPorts: ContextFactsPorts = {
  task: pullHubTask,
  lookup: readHubTaskReference,
  record: readHubTaskReferenceByRecordId,
  children: readHubTaskChildren,
  pointer: pointerRefusal,
}
const defaultContextFactsPorts = () =>
  portsHolder[CONTEXT_FACTS_PORTS_KEY] ?? productionContextFactsPorts

export function storedItems(holder: string, database: Database): ContextItem[] {
  return listContextItems(holder, database)
}

export async function contextCursorOwner(holder: string, database: Database = db()) {
  const address = splitContextHolder(holder)
  if (address.holderKind !== 'cursor') return null
  const row = await taskFlowReadStore(database).stageByRecordId(address.holderId)
  return row ? { session_id: row.session_id, project: row.project } : null
}

/** Resolve one task and the direct children needed to classify its context profile. */
export async function resolveContextTaskWithChildren(
  value: string,
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<{ task: ContextTask; children: ContextTask[] }> {
  const key = value.trim().toUpperCase()
  const prefix = taskKeyPrefix(key) ?? key.split('-', 1)[0] ?? key
  const project = projectForTaskKey(key, projects(undefined, database))
  if (!project) throw new ContextTaskPrefixError(key, prefix)
  const task = await resolveOrPullHubTaskReference(project.name, key, ports.lookup, ports.task)
  let children: ContextTask[]
  try {
    children = await ports.children(project.name, task.key)
  } catch (error) {
    throw taskReadRefusal(project.name, error instanceof Error ? error.message : String(error))
  }
  return {
    task,
    children,
  }
}

export async function lookupContextTask(
  project: string,
  key: string,
  ports: ContextFactsPorts = defaultContextFactsPorts(),
) {
  return ports.lookup(project, key)
}

type ContextTaskByRecordId = { task: ContextTask | null; failure: string | null }

/** Resolve the stable task identity used in a context subject, preserving a point-read failure. */
export async function resolveContextTaskByRecordId(
  recordId: string,
  _database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<ContextTaskByRecordId> {
  try {
    return { task: await ports.record(recordId), failure: null }
  } catch (error) {
    if (taskRecordFailureNamesMissingTask(error, recordId)) return { task: null, failure: null }
    return { task: null, failure: error instanceof Error ? error.message : String(error) }
  }
}

export function taskProfile(key: string, tasks: readonly ContextTask[]): ContextProfile {
  return tasks.some((task) => task.parent_key === key) ? 'epic' : 'task'
}

async function claimedContextTask(
  claim: { key: string; project: string },
  ports: ContextFactsPorts,
) {
  return ports.lookup(claim.project, claim.key).catch(() => null)
}

async function parentContextTask(task: ContextTask, ports: ContextFactsPorts) {
  if (!task.parent_key) return null
  return ports.lookup(task.project, task.parent_key).catch(() => null)
}

async function relatedContextTasks(input: {
  owner: string | null
  claims: readonly { key: string; project: string }[]
  task?: ContextTask
  ports: ContextFactsPorts
}): Promise<ContextTask[]> {
  const related: ContextTask[] = []
  if (!input.owner) {
    const parent = input.task ? await parentContextTask(input.task, input.ports) : null
    if (parent) related.push(parent)
    return related
  }
  for (const claim of input.claims) {
    const claimed = await claimedContextTask(claim, input.ports)
    if (!claimed) continue
    related.push(claimed)
    const parent = await parentContextTask(claimed, input.ports)
    if (parent) related.push(parent)
  }
  return related
}

async function contextSetRefusal(
  input: {
    holder: string
    item: ContextItem
    contextTask?: ContextTask
    contextTaskChildren?: readonly ContextTask[]
  },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<string | null> {
  const item = input.item
  const owner = input.holder.startsWith('session:') ? input.holder.slice(8) : null
  const task = input.holder.startsWith('task:') ? input.contextTask : undefined
  if (
    input.holder.startsWith('task:') &&
    (!task || input.holder !== taskContextHolder(task.record_id))
  ) {
    return `context item ${item.id} refused: task holder requires its resolved task identity; write task context with ${PLATFORM_SLUG} agent context set --task <KEY>`
  }
  const ownership = holderOwnershipRefusal(
    input.holder,
    sessionId(database),
    item.id,
    (await contextCursorOwner(input.holder, database))?.session_id,
  )
  if (ownership) return ownership
  const claims = owner
    ? liveClaimsOfSession(owner, Date.now(), database)
        .filter((claim) => claim.subject.kind === 'task')
        .map((claim) => ({ key: claim.subject.value, project: claim.project }))
    : []
  const projectTasks = task ? (input.contextTaskChildren ?? []) : []
  const profile = task ? taskProfile(task.key, projectTasks) : 'session'
  const relatedTasks = await relatedContextTasks({
    owner,
    claims,
    task,
    ports,
  })
  const relatedHolders = [
    ...new Set(relatedTasks.map((related) => taskContextHolder(related.record_id))),
  ]
  const refusal = contextWriteRefusal(item, {
    profile,
    siblings: storedItems(input.holder, database),
    related: [...new Set(relatedHolders)].flatMap((holder) => storedItems(holder, database)),
    pointerRefusal: item.kind === 'pointer' ? await ports.pointer(item.body, database) : null,
    claimedTask: claims[0]?.key ?? null,
  })
  return refusal
}

export async function assertContextSetAllowed(input: {
  holder: string
  item: ContextItem
  contextTask?: ContextTask
  contextTaskChildren?: readonly ContextTask[]
}): Promise<void> {
  const refusal = await contextSetRefusal(input)
  if (refusal) throw new ContextWriteRefusalError(refusal)
}

/** A context item leaves only through its owner. */
export async function assertContextDropAllowed({
  item,
  database = db(),
}: {
  item: ContextItem
  database?: Database
}): Promise<void> {
  const refusal = holderOwnershipRefusal(
    item.holder,
    sessionId(database),
    item.id,
    (await contextCursorOwner(item.holder, database))?.session_id,
  )
  if (refusal) throw new ContextWriteRefusalError(refusal)
}
