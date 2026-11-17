// concern: record-question-store
/** Adapts hosted question routes, with only machine-owned inbox liveness enriched locally. */

import type { Database } from 'bun:sqlite'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { projectByRecordId } from '../project/project-read.ts'
import type { RecordWriteDestination } from '../record/record-api-client-paths.ts'
import type { RecordQuestionClient } from '../record/record-api-client-question.ts'
import type { RecordIdentity } from '../record/record-auth.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
} from '../record/record-question-contract.ts'
import { questionChangedAfterRefusal } from '../record/record-question-contract.ts'
import { decideSingleRecordSpace } from '../record/record-space-cardinality.ts'
import { resolveQuestionRunPusher } from './question-run-pusher.ts'
import type { QuestionReadResult, QuestionReadRow, QuestionStore } from './question-store-types.ts'

function localQuestionRow(
  database: Database,
  row: Record<string, unknown>,
  enrichMachineFields: boolean,
): QuestionReadRow {
  const mapped = { ...row }
  if (mapped.record_id === undefined && typeof mapped.id === 'string') {
    mapped.record_id = mapped.id
    delete mapped.id
  }
  if (
    mapped.run_record_id === undefined &&
    (typeof mapped.run_id === 'string' || mapped.run_id === null)
  )
    mapped.run_record_id = mapped.run_id
  if (
    mapped.workflow_task_record_id === undefined &&
    (typeof mapped.workflow_task_id === 'string' || mapped.workflow_task_id === null)
  )
    mapped.workflow_task_record_id = mapped.workflow_task_id
  delete mapped.run_id
  delete mapped.workflow_task_id
  if (!enrichMachineFields) return mapped as QuestionReadRow
  const ownerId = typeof mapped.owner_id === 'string' ? mapped.owner_id : null
  const owner = ownerId
    ? database
        .query<{ pid: number | null; cwd: string | null }, [string]>(
          'SELECT pid,cwd FROM run WHERE record_id=?',
        )
        .get(ownerId)
    : null
  mapped.owner_pid = owner?.pid ?? null
  const repo = typeof mapped.repo === 'string' ? mapped.repo : null
  mapped.project_path = repo
    ? (database.query<{ path: string }, [string]>('SELECT path FROM project WHERE name=?').get(repo)
        ?.path ?? null)
    : null
  mapped.cwd = owner?.cwd ?? mapped.project_path
  return mapped as QuestionReadRow
}

function readMetadata(result: QuestionReadResult) {
  return {
    ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    ...(result.more === undefined ? {} : { more: result.more }),
    ...(result.reset === undefined ? {} : { reset: result.reset }),
  }
}

function inboxItems(database: Database, items: QuestionReadRow[]): QuestionReadRow[] {
  const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
  return items.map((row) => {
    if (!('run_record_id' in row)) return row
    const inboxRow = row as QuestionReadRow & { session_id?: unknown }
    const sessionId = typeof inboxRow.session_id === 'string' ? inboxRow.session_id : null
    const recent = sessionId
      ? (database
          .query<{ recent: number }, [string, string]>(
            'SELECT CASE WHEN last_seen>=? THEN 1 ELSE 0 END recent FROM session_seen WHERE session_id=?',
          )
          .get(cutoff, sessionId)?.recent ?? 0)
      : 0
    return { ...row, session_recent: recent }
  })
}

type SpaceCursors = Record<string, string>
const encodeSpaceCursors = (spaces: SpaceCursors) =>
  Buffer.from(JSON.stringify({ version: 1, spaces })).toString('base64url')
function decodeSpaceCursors(value: string): SpaceCursors {
  if (value === '0') return {}
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      version?: unknown
      spaces?: unknown
    }
    if (parsed.version !== 1 || !parsed.spaces || typeof parsed.spaces !== 'object') throw null
    if (Object.values(parsed.spaces).some((cursor) => typeof cursor !== 'string' || !cursor))
      throw null
    return parsed.spaces as SpaceCursors
  } catch {
    throw new Error(
      'question change cursor is malformed; retry without changedAfter for a fresh cursor',
    )
  }
}

const SINGLE_SPACE_READ_KINDS = ['by-id', 'for-run', 'for-cursor'] as const

export class RecordQuestionStore implements QuestionStore {
  private readonly input: {
    database: Database
    client: RecordQuestionClient
  }
  private identityRead?: Promise<RecordIdentity>
  private readonly destinations = new Map<string, Promise<RecordWriteDestination>>()
  private everyDestination?: Promise<RecordWriteDestination[]>
  private readonly questionSpaces = new Map<string, RecordWriteDestination>()

  constructor(input: RecordQuestionStore['input']) {
    this.input = input
  }

  // A store is reused across calls, so a rejected read is forgotten rather than
  // replayed: the next call retries once the record answers again.
  private identity(): Promise<RecordIdentity> {
    this.identityRead ??= (
      this.input.client.whoami
        ? this.input.client.whoami()
        : Promise.reject(
            new Error('record API predates identity reads; release hosted-api, then retry'),
          )
    ).catch((error: unknown) => {
      this.identityRead = undefined
      throw error
    })
    return this.identityRead
  }

  private destination(projectId: string): Promise<RecordWriteDestination> {
    const cached = this.destinations.get(projectId)
    if (cached) return cached
    const project = projectByRecordId(projectId, this.input.database)
    if (!project) throw new Error(`project ${projectId} is not registered; register it, then retry`)
    const result = requireProjectRecordDestination(project.name, project.settings, {
      whoami: () => this.identity(),
    })
      .then((destinationSpaceId) => ({ destinationSpaceId }))
      .catch((error: unknown) => {
        this.destinations.delete(projectId)
        throw error
      })
    this.destinations.set(projectId, result)
    return result
  }

  private async writeDestination(projectId: string | null): Promise<RecordWriteDestination> {
    if (projectId) return this.destination(projectId)
    const identity = await this.identity()
    if (!identity.personalSpaceId)
      throw new Error(
        'the signed-in user has no personal record space; repair record identity, then retry',
      )
    return { destinationSpaceId: identity.personalSpaceId }
  }

  private allDestinations(): Promise<RecordWriteDestination[]> {
    this.everyDestination ??= this.identity()
      .then((identity) => {
        const ids = new Set(
          parseRecordSpaceMemberships(identity.memberships).map(({ spaceId }) => spaceId),
        )
        if (identity.personalSpaceId) ids.add(identity.personalSpaceId)
        return [...ids].map((destinationSpaceId) => ({ destinationSpaceId }))
      })
      .catch((error: unknown) => {
        this.everyDestination = undefined
        throw error
      })
    return this.everyDestination
  }

  private async readAt(input: QuestionReadInput, destination: RecordWriteDestination) {
    if (!this.input.client.readQuestions)
      throw new Error('record API predates direct question reads; release hosted-api, then retry')
    return this.input.client.readQuestions(input, destination)
  }

  private async singleSpaceRead(input: QuestionReadInput): Promise<QuestionReadResult> {
    const answers = await Promise.all(
      (await this.allDestinations()).map(async (destination) => ({
        destination,
        value: await this.readAt(input, destination),
      })),
    )
    const decision = decideSingleRecordSpace(
      answers.map(({ destination, value }) => ({
        spaceId: destination.destinationSpaceId,
        found: value.items.length > 0,
      })),
    )
    if ('refused' in decision)
      throw new Error(
        `${decision.refused}; remove the duplicate question from all but its authoritative space, then retry`,
      )
    if (decision.index === null) return { items: [] }
    const answer = answers[decision.index]!
    for (const row of answer.value.items) {
      const id = row.record_id ?? row.id
      if (typeof id === 'string') this.questionSpaces.set(id, answer.destination)
    }
    return answer.value
  }

  private async listRead(input: QuestionReadInput): Promise<QuestionReadResult> {
    const positions = input.changedAfter ? decodeSpaceCursors(input.changedAfter) : null
    const answers = await Promise.all(
      (await this.allDestinations()).map(async (destination) => {
        const request =
          input.read === 'rulings' && positions
            ? {
                ...input,
                limit: undefined,
                changedAfter: positions[destination.destinationSpaceId],
              }
            : input.read === 'inbox' && positions
              ? {
                  ...input,
                  changedAfter: positions[destination.destinationSpaceId] ?? '0',
                }
              : input
        return { destination, value: await this.readAt(request, destination) }
      }),
    )
    const cursors = Object.fromEntries(
      answers.flatMap(({ destination, value }) =>
        value.cursor ? [[destination.destinationSpaceId, value.cursor] as const] : [],
      ),
    )
    return {
      items: answers.flatMap(({ value }) => value.items),
      ...(Object.keys(cursors).length ? { cursor: encodeSpaceCursors(cursors) } : {}),
      ...(answers.some(({ value }) => value.more) ? { more: true } : {}),
      ...(answers.some(({ value }) => value.reset) ? { reset: true } : {}),
    }
  }

  async write(intent: QuestionIntent, input: QuestionWriteBody) {
    if (!this.input.client.writeQuestion)
      throw new Error('record API predates direct question writes; release hosted-api, then retry')
    if (intent === 'ask' && input.question.runId) {
      await resolveQuestionRunPusher()(this.input.database, input.question.runId)
    }
    let destination: RecordWriteDestination
    if (intent === 'ask') destination = await this.writeDestination(input.question.projectId)
    else {
      let found = this.questionSpaces.get(input.question.id)
      if (!found) {
        await this.singleSpaceRead({ read: 'by-id', ids: [input.question.id] })
        found = this.questionSpaces.get(input.question.id)
      }
      if (!found)
        throw new Error(
          `question ${input.question.id} was not found in any reachable record space; rerun the command, then retry`,
        )
      destination = found
    }
    return await this.input.client.writeQuestion(intent, input, destination)
  }

  async read(input: QuestionReadInput, projectId?: string): Promise<QuestionReadResult> {
    if (input.read === 'by-number' && !projectId)
      throw new Error(
        'question numbers are unique only within a record space; pass the question UUID, then retry',
      )
    if (input.changedAfter !== undefined && input.read !== 'rulings' && input.read !== 'inbox')
      throw new Error(
        `${questionChangedAfterRefusal.message}; ${questionChangedAfterRefusal.remedy}`,
      )
    const result = projectId
      ? await this.readAt(input, await this.destination(projectId))
      : (SINGLE_SPACE_READ_KINDS as readonly string[]).includes(input.read)
        ? await this.singleSpaceRead(input)
        : await this.listRead(input)
    const enrichMachineFields = (SINGLE_SPACE_READ_KINDS as readonly string[]).includes(input.read)
    const items = result.items.map((row) =>
      localQuestionRow(this.input.database, row, enrichMachineFields),
    )
    if (input.read !== 'inbox')
      return {
        items,
        ...readMetadata(result),
      }
    return {
      items: inboxItems(this.input.database, items),
      ...readMetadata(result),
    } as QuestionReadResult
  }
}
