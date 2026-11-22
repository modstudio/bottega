// concern: record-question-store
/** Adapts hosted question routes, with only machine-owned inbox liveness enriched locally. */

import type { Database } from 'bun:sqlite'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import type {
  RecordRequestDestination,
  RecordWriteDestination,
} from '../record/record-api-client-paths.ts'
import {
  type RecordQuestionClient,
  requireQuestionWriteClient,
} from '../record/record-api-client-question.ts'
import { isAbsentRecordKeyedRead } from '../record/record-api-client-response.ts'
import type {
  QuestionLiveIntent,
  QuestionReadInput,
  QuestionWriteBody,
} from '../record/record-question-contract.ts'
import {
  isMembershipQuestionRead,
  QUESTION_RULINGS_PAGE_SIZE,
  questionChangedAfterRefusal,
} from '../record/record-question-contract.ts'
import {
  ProjectRecordDestinationRefusal,
  questionWriteDestinations,
} from '../record/record-question-destination.ts'
import { compareQuestionsByAsk } from './question-order.ts'
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

function questionRowRecordId(row: Record<string, unknown>): string | null {
  const id = row.record_id ?? row.id
  return typeof id === 'string' ? id : null
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

export function rulingSpaceReadRequest(
  input: Extract<QuestionReadInput, { read: 'rulings' }>,
  position: string | undefined,
): Extract<QuestionReadInput, { read: 'rulings' }> {
  const { changedAfter: _changedAfter, limit: _limit, ...read } = input
  return position
    ? { ...read, changedAfter: position }
    : { ...read, limit: QUESTION_RULINGS_PAGE_SIZE }
}

const SPACE_KEYED_READ_KINDS = [
  'by-id',
  'for-run',
  'for-cursor',
  'for-runs',
  'open-for-cursors',
] as const
// open-for-cursors returns partial id, cursor, space, and number rows, so it skips machine enrichment below.

export class RecordQuestionStore implements QuestionStore {
  private readonly input: {
    database: Database
    client: RecordQuestionClient
  }
  private readonly destination: (projectId: string | null) => Promise<RecordWriteDestination>
  private everyDestination?: Promise<RecordWriteDestination[]>
  private readonly questionSpaces = new Map<string, RecordWriteDestination>()

  constructor(input: RecordQuestionStore['input']) {
    this.input = input
    this.destination = questionWriteDestinations({
      database: input.database,
      whoami: () =>
        input.client.whoami
          ? input.client.whoami()
          : Promise.reject(
              new Error('record API predates identity reads; release hosted-api, then retry'),
            ),
    })
  }

  async projectSpace(projectId: string): Promise<string | null> {
    try {
      return (await this.destination(projectId)).destinationSpaceId
    } catch (error) {
      if (error instanceof ProjectRecordDestinationRefusal) return null
      throw error
    }
  }

  private allDestinations(): Promise<RecordWriteDestination[]> {
    this.everyDestination ??= (
      this.input.client.whoami
        ? this.input.client.whoami()
        : Promise.reject(
            new Error('record API predates identity reads; release hosted-api, then retry'),
          )
    )
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

  private async readAt(input: QuestionReadInput, destination?: RecordRequestDestination) {
    if (!this.input.client.readQuestions)
      throw new Error('record API predates direct question reads; release hosted-api, then retry')
    return this.input.client.readQuestions(input, destination)
  }

  private async spaceKeyedRead(input: QuestionReadInput): Promise<QuestionReadResult> {
    const value = await this.readAt(input).catch((error: unknown) => {
      if (isAbsentRecordKeyedRead(error)) return { items: [] }
      throw error
    })
    return {
      items: this.rememberSpacesAndSort(value.items),
    }
  }

  private rememberSpacesAndSort(items: QuestionReadResult['items']): QuestionReadResult['items'] {
    for (const row of items) {
      const id = questionRowRecordId(row)
      const spaceId = row.space_id
      if (id && typeof spaceId === 'string')
        this.questionSpaces.set(id, { destinationSpaceId: spaceId })
    }
    return items.sort(compareQuestionsByAsk)
  }

  private async membershipRead(input: QuestionReadInput): Promise<QuestionReadResult> {
    if (!this.input.client.readMembershipQuestions)
      throw new Error(
        'record API predates membership question reads; deploy the hosted API with `scripts/deploy/hosted api`, then retry',
      )
    const value = await this.input.client.readMembershipQuestions(input)
    return { ...value, items: this.rememberSpacesAndSort(value.items) }
  }

  private async listRead(input: QuestionReadInput): Promise<QuestionReadResult> {
    const positions = input.changedAfter ? decodeSpaceCursors(input.changedAfter) : null
    const answers = await Promise.all(
      (await this.allDestinations()).map(async (destination) => {
        const request =
          input.read === 'rulings' && positions
            ? rulingSpaceReadRequest(input, positions[destination.destinationSpaceId])
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

  async write(intent: QuestionLiveIntent, input: QuestionWriteBody) {
    const client = requireQuestionWriteClient(this.input.client)
    if (
      intent === 'ask' &&
      !input.question.projectId &&
      (input.question.runId || input.question.workflowCursorRecordId)
    ) {
      const owner = input.question.runId
        ? `run ${input.question.runId}`
        : `workflow cursor ${input.question.workflowCursorRecordId}`
      throw new Error(`ask for ${owner} carries no project; pass its project, then retry`)
    }
    if (intent === 'ask' && input.question.runId) {
      await resolveQuestionRunPusher()(this.input.database, input.question.runId)
    }
    let destination: RecordWriteDestination
    if (intent === 'ask') destination = await this.destination(input.question.projectId)
    else {
      let found = this.questionSpaces.get(input.question.id)
      if (!found) {
        await this.spaceKeyedRead({ read: 'by-id', ids: [input.question.id] })
        found = this.questionSpaces.get(input.question.id)
      }
      if (!found)
        throw new Error(
          `question ${input.question.id} was not found in any reachable record space; rerun the command, then retry`,
        )
      destination = found
    }
    return await client.writeQuestion(intent, input, destination)
  }

  async read(input: QuestionReadInput, projectId?: string): Promise<QuestionReadResult> {
    if (input.changedAfter !== undefined && input.read !== 'rulings' && input.read !== 'inbox')
      throw new Error(
        `${questionChangedAfterRefusal.message}; ${questionChangedAfterRefusal.remedy}`,
      )
    const membershipRead = !projectId && isMembershipQuestionRead(input)
    const result = projectId
      ? await this.readAt(input, await this.destination(projectId))
      : membershipRead
        ? await this.membershipRead(input)
        : (SPACE_KEYED_READ_KINDS as readonly string[]).includes(input.read)
          ? await this.spaceKeyedRead(input)
          : await this.listRead(input)
    const enrichMachineFields =
      input.read !== 'open-for-cursors' &&
      (SPACE_KEYED_READ_KINDS as readonly string[]).includes(input.read)
    const items = result.items.map((row) =>
      localQuestionRow(this.input.database, row, enrichMachineFields),
    )
    if (input.read === 'by-number' && !projectId) {
      const questions = new Set(items.map((row) => questionRowRecordId(row)).filter(Boolean))
      if (questions.size > 1)
        throw new Error(
          `question number ${input.number} exists in more than one project; pass the question UUID, then retry`,
        )
    }
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
