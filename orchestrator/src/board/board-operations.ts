// concern: board-operation-routing
/** Routes board operations to the local store or hosted record without mixing their writes. */
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { machineId } from '../record/machine-identity.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import type { HostedBoardMessage, HostedBoardThread } from '../record/record-board-contract.ts'
import { acceptedAnswerNoteText, fileAcceptedAnswerNote } from './board-answer-note.ts'
import { BOARD_CLAIM_DEFAULT_MS } from './board-claim-policy.ts'
import {
  type ClaimView,
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  type TakeClaimInput,
  takeClaim,
} from './board-claim-service.ts'
import { boardMode } from './board-mode.ts'
import {
  architectIdentity,
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
  parseAudience,
} from './board-policy.ts'
import {
  acknowledgeNotice,
  noticeStatus,
  type PostNoticeInput,
  postNotice,
  withdrawNotice,
} from './board-service.ts'
import { boardActor } from './board-store.ts'
import {
  acceptAnswer,
  askQuestion,
  fileAnswerNote,
  readThread,
  replyToThread,
} from './board-thread-service.ts'

type Environment = Record<string, string | undefined>
type Context = { env?: Environment; clock?: number; cwd?: string; client?: RecordApiClient }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function context(input: Context = {}) {
  return {
    env: input.env ?? process.env,
    clock: input.clock ?? Date.now(),
    cwd: input.cwd ?? process.cwd(),
    client: input.client,
  }
}

function hostedClient(c: ReturnType<typeof context>): RecordApiClient {
  return c.client ?? recordApiClient()
}

function locality(audience: string) {
  return parseAudience(audience).kind === 'machine'
    ? ('machine-audience' as const)
    : ('shared' as const)
}

function idForMode(id: string, mode: 'local' | 'hosted', noun = 'board id'): number | string {
  if (mode === 'hosted') {
    if (!UUID.test(id))
      throw new Error(
        `${noun} must be a UUID in hosted mode because hosted board ids are opaque record ids`,
      )
    return id
  }
  const number = Number(id)
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(number))
    throw new Error(
      `${noun} must be a positive integer string in local mode because local board ids are SQLite row ids`,
    )
  return number
}

const stringId = (value: number | string | null) => (value === null ? null : String(value))

function localPostResult(value: ReturnType<typeof postNotice>) {
  return { ...value, id: String(value.id) }
}

function localThread(value: ReturnType<typeof readThread>) {
  return {
    ...value,
    root: {
      ...value.root,
      id: String(value.root.id),
      acceptedReplyId: stringId(value.root.acceptedReplyId),
    },
    replies: value.replies.map((reply) => ({ ...reply, id: String(reply.id) })),
  }
}

function localClaim(value: ClaimView) {
  return {
    ...value,
    id: String(value.id),
    previousClaimIds: value.previousClaimIds.map(String),
    supersededByClaimId: stringId(value.supersededByClaimId),
  }
}

function authorFacts(env: Environment, database = db()) {
  const actor = boardActor(env)
  const identity = architectIdentity(env)
  const localRunId = Number(env.ORCH_RUN_ID ?? 0)
  const run =
    localRunId > 0
      ? database
          .query<{ record_id: string | null; session_id: string | null }, [number]>(
            'SELECT record_id,session_id FROM run WHERE id=?',
          )
          .get(localRunId)
      : null
  return {
    session: actor.session,
    harness: identity?.harness ?? null,
    machine: machineId(),
    runId: run?.record_id && run.session_id === actor.session ? run.record_id : null,
    currentTaskKey: actor.session
      ? (database
          .query<{ current_task_key: string | null }, [string]>(
            'SELECT current_task_key FROM presence WHERE session_id=?',
          )
          .get(actor.session)?.current_task_key ?? null)
      : null,
  }
}

function hostedPostInput(
  kind: 'notice' | 'question',
  input: PostNoticeInput,
  c: ReturnType<typeof context>,
) {
  const actor = authorFacts(c.env)
  const project = projectAt(c.cwd)?.name
  const expiresAt = new Date(c.clock + (input.expiresMs ?? BOARD_DEFAULT_EXPIRY_MS)).toISOString()
  return {
    id: newRecordId(),
    kind,
    audience: input.audience,
    title: input.title,
    body: input.body,
    ackRequired: Boolean(input.ackRequired),
    ackDeadline: input.ackRequired
      ? new Date(c.clock + (input.deadlineMs ?? BOARD_DEFAULT_ACK_DEADLINE_MS)).toISOString()
      : null,
    expiresAt,
    task: input.task,
    paths: input.paths,
    topics: input.topics,
    authorSession: actor.session,
    authorHarness: actor.harness,
    authorMachineId: actor.machine,
    authorRunId: actor.runId,
    project,
    currentTaskKey: actor.currentTaskKey,
  }
}

export async function boardPost(input: PostNoticeInput, inputContext?: Context) {
  const c = context(inputContext)
  if (boardMode(locality(input.audience), c.env) === 'local')
    return localPostResult(postNotice(input, c.env, c.clock, c.cwd))
  const row = await hostedClient(c).postBoardMessage(hostedPostInput('notice', input, c))
  return { id: row.id, dropped: false }
}

export async function boardAsk(
  input: Omit<PostNoticeInput, 'ackRequired' | 'deadlineMs' | 'suggestingRunId'>,
  inputContext?: Context,
) {
  const c = context(inputContext)
  if (boardMode(locality(input.audience), c.env) === 'local')
    return localPostResult(askQuestion(input, c.env, c.clock, c.cwd))
  const row = await hostedClient(c).postBoardMessage(hostedPostInput('question', input, c))
  return { id: row.id, dropped: false }
}

export async function boardReply(id: string, body: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode, 'board thread id')
  if (mode === 'local') {
    const result = replyToThread(parsed as number, body, c.env, c.clock, c.cwd)
    return { ...result, id: String(result.id), rootId: String(result.rootId) }
  }
  const actor = authorFacts(c.env)
  const row = await hostedClient(c).replyBoardMessage(parsed as string, {
    id: newRecordId(),
    body,
    authorSession: actor.session,
    authorHarness: actor.harness,
    authorMachineId: actor.machine,
    authorRunId: actor.runId,
  })
  return { id: row.id, rootId: id, dropped: false }
}

export async function boardThread(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode, 'board thread id')
  return mode === 'local'
    ? localThread(readThread(parsed as number, c.env, c.clock))
    : hostedClient(c).getBoardThread(parsed as string)
}

const originText = (origin: HostedBoardMessage['origin']) =>
  origin.session ? `${origin.kind} ${origin.session}` : origin.kind

async function fileHostedNote(
  questionId: string,
  thread: HostedBoardThread,
  c: ReturnType<typeof context>,
) {
  const client = hostedClient(c)
  await client.takeBoardFilingLease(questionId, { authorSession: boardActor(c.env).session })
  const reply = thread.replies.find((row) => row.id === thread.root.acceptedReplyId)
  if (!reply) throw new Error(`board question ${questionId} accepted reply is unavailable`)
  try {
    const filed = await fileAcceptedAnswerNote(
      {
        text: acceptedAnswerNoteText({
          title: thread.root.title ?? '',
          replyBody: reply.body,
          askerOrigin: originText(thread.root.origin),
          answererOrigin: originText(reply.origin),
        }),
        new: true,
      },
      { cwd: c.cwd },
    )
    const recordId = 'recordId' in filed ? filed.recordId : null
    if (typeof recordId !== 'string') throw new Error('filed note has no record id')
    await client.completeBoardFilingLease(questionId, {
      noteId: recordId,
      authorSession: boardActor(c.env).session,
    })
    return { noteId: filed.noteId, notePendingError: null, retry: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await client.failBoardFilingLease(questionId, {
      error: detail,
      authorSession: boardActor(c.env).session,
    })
    return { noteId: null, notePendingError: detail, retry: `orch board file-note ${questionId}` }
  }
}

export async function boardAccept(questionId: string, replyId: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const question = idForMode(questionId, mode, 'board question id')
  const reply = idForMode(replyId, mode, 'board reply id')
  if (mode === 'local') {
    const value = await acceptAnswer(question as number, reply as number, c.env, c.clock, c.cwd)
    return { ...value, accepted: String(value.accepted), questionId: String(value.questionId) }
  }
  const thread = await hostedClient(c).acceptBoardAnswer(question as string, {
    replyId: reply as string,
    authorSession: boardActor(c.env).session,
  })
  return { accepted: replyId, questionId, ...(await fileHostedNote(questionId, thread, c)) }
}

export async function boardFileNote(questionId: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const question = idForMode(questionId, mode, 'board question id')
  if (mode === 'local')
    return { ...(await fileAnswerNote(question as number, c.env, c.cwd)), questionId }
  return {
    questionId,
    ...(await fileHostedNote(questionId, await hostedClient(c).getBoardThread(questionId), c)),
  }
}

export async function boardWithdraw(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode)
  if (mode === 'local') withdrawNotice(parsed as number, c.env, c.clock)
  else
    await hostedClient(c).withdrawBoardMessage(parsed as string, {
      authorSession: boardActor(c.env).session,
    })
  return { withdrawn: id }
}

export async function boardAcknowledge(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode)
  if (mode === 'local') acknowledgeNotice(parsed as number, c.env, c.clock)
  else {
    const session = boardActor(c.env).session
    if (!session)
      throw new Error(
        'hosted board acknowledgement requires an architect session; sign in from a supported architect harness',
      )
    // An acknowledged receipt never escalates; the cache change will first store the real posting-time value.
    await hostedClient(c).putBoardReceipt({
      messageId: parsed as string,
      readerSession: session,
      audienceAtPosting: true,
      acknowledged: true,
    })
  }
  return { acknowledged: id }
}

export async function boardStatus(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode)
  if (mode === 'hosted') return hostedClient(c).getBoardStatus(parsed as string)
  const status = noticeStatus(parsed as number, c.env, c.clock)
  return { ...status, message: { ...status.message, id: String(status.message.id) } }
}

function claimProject(input: TakeClaimInput, cwd: string) {
  const name = input.project ?? projectAt(cwd)?.name
  if (!name || !projectByName(name))
    throw new Error('claim project is unknown; use --project from a registered project')
  return name
}

function hostedClaimRunId(runId: number | undefined, env: Environment): string | null | undefined {
  if (runId === undefined) return undefined
  const actor = boardActor(env)
  const row = db()
    .query<{ record_id: string | null; session_id: string | null }, [number]>(
      'SELECT record_id,session_id FROM run WHERE id=?',
    )
    .get(runId)
  if (!row) throw new Error(`no run ${runId}; use a run owned by this session`)
  if (!actor.session || row.session_id !== actor.session)
    throw new Error(`run ${runId} is not owned by the claim holder's session`)
  if (!row.record_id)
    throw new Error(`run ${runId} has no hosted record id; sync the run with orch sync and retry`)
  return row.record_id
}

export async function boardClaimTake(input: TakeClaimInput, inputContext?: Context) {
  const c = context(inputContext)
  if (boardMode('shared', c.env) === 'local')
    return localClaim(takeClaim(input, c.env, c.clock, c.cwd))
  if (input.force)
    throw new Error(
      'hosted claim take does not support --force; release the conflicting claim or wait for its lease',
    )
  const row = await hostedClient(c).takeBoardClaim({
    id: newRecordId(),
    project: claimProject(input, c.cwd),
    subject: input.subject,
    durationMs: input.durationMs ?? BOARD_CLAIM_DEFAULT_MS,
    runId: hostedClaimRunId(input.runId, c.env),
    note: input.note,
    holderSession: boardActor(c.env).session,
  })
  return row
}

export async function boardClaimRenew(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode, 'board claim id')
  return mode === 'local'
    ? localClaim(renewClaim(parsed as number, c.env, c.clock))
    : hostedClient(c).renewBoardClaim(parsed as string, {
        holderSession: boardActor(c.env).session,
      })
}
export async function boardClaimRelease(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardMode('shared', c.env)
  const parsed = idForMode(id, mode, 'board claim id')
  return mode === 'local'
    ? localClaim(releaseClaim(parsed as number, c.env, c.clock))
    : hostedClient(c).releaseBoardClaim(parsed as string, {
        holderSession: boardActor(c.env).session,
      })
}
export async function boardClaimList(
  project: string | undefined,
  all = false,
  inputContext?: Context,
) {
  const c = context(inputContext)
  if (boardMode('shared', c.env) === 'local')
    return { claims: listClaims(project, all, c.env, c.clock, c.cwd).claims.map(localClaim) }
  const hosted = await hostedClient(c).listBoardClaims(
    claimProject({ subject: 'resource:list', project }, c.cwd),
  )
  return { claims: all ? hosted.claims : hosted.claims.filter((claim) => claim.live) }
}
export async function boardClaimReleaseTask(key: string, project: string, inputContext?: Context) {
  const c = context(inputContext)
  return boardMode('shared', c.env) === 'local'
    ? releaseTaskClaims(key, project, c.env, c.clock)
    : hostedClient(c).releaseBoardTaskClaims({ key, project })
}
