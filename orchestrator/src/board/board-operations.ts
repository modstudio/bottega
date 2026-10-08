// concern: board-operation-routing
/** Routes board operations to the local store or hosted record without mixing their writes. */
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
} from '../../../shared/board-duration.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { machineId } from '../record/machine-identity.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import type {
  HostedBoardClaim,
  HostedBoardMessage,
  HostedBoardReceipt,
  HostedBoardStatus,
  HostedBoardThread,
} from '../record/record-board-contract.ts'
import { acceptedAnswerNoteText, fileAcceptedAnswerNote } from './board-answer-note.ts'
import { BOARD_CLAIM_DEFAULT_MS } from './board-claim-policy.ts'
import {
  type ClaimView,
  claimProject,
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  type TakeClaimInput,
  takeClaim,
} from './board-claim-service.ts'
import { cachedAudienceAtPosting } from './board-hosted-cache.ts'
import { boardMode, boardModeForId } from './board-mode.ts'
import {
  acknowledgementRefusal,
  architectIdentity,
  OPERATOR_READER,
  parseAudience,
} from './board-policy.ts'
import {
  acknowledgeNotice,
  noticeStatus,
  type PostNoticeInput,
  postNotice,
  withdrawNotice,
} from './board-service.ts'
import { type BoardOrigin, boardActor, boardOrigin, originText } from './board-store.ts'
import { boardThreadState } from './board-thread-policy.ts'
import {
  acceptAnswer,
  askQuestion,
  fileAnswerNote,
  readThread,
  replyToThread,
} from './board-thread-service.ts'

type Environment = Record<string, string | undefined>
type Context = { env?: Environment; clock?: number; cwd?: string; client?: RecordApiClient }

export type BoardPostResult = {
  id: string
  dropped: boolean
  reached: number | null
  warning: string | null
}

type BoardReplyResult = BoardPostResult & { rootId: string }

type BoardMessageResult = {
  id: string
  kind: string | null
  threadRootId: string | null
  title: string | null
  body: string | null
  audience: string | null
  origin: BoardOrigin | null
  senderTags: { kind: 'task' | 'path' | 'topic'; value: string }[] | null
  createdAt: string | null
  expiresAt: string | null
  withdrawnAt: string | null
  state: string | null
  acceptedReplyId: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  noteId: string | null
  notePendingError: string | null
  revision: string | null
  scopeProjectIds: string[] | null
  recipientUserIds: string[] | null
  claimId: string | null
  authorUserId: string | null
  authorSession: string | null
  ackRequired: boolean | null
  ackDeadline: string | null
  text: string | null
}

type BoardReplyView = {
  id: string
  body: string
  origin: BoardOrigin
  createdAt: string
}

export type BoardThreadResult = { root: BoardMessageResult; replies: BoardReplyView[] }

type BoardReceiptResult = {
  messageId: string
  readerUserId: string | null
  readerSession: string
  audienceAtPosting: boolean
  deliveredAt: string | null
  acknowledgedAt: string | null
}

export type BoardStatusResult = {
  message: BoardMessageResult
  receipts: BoardReceiptResult[]
  reached: number | null
  acknowledged: number | null
  unacknowledged: string[] | null
}

export type BoardClaimResult = {
  id: string
  project: string
  subject: { kind: 'task' | 'path' | 'resource'; value: string }
  holder: string
  note: string | null
  runId: string | null
  takenAt: string
  renewedAt: string
  lapsesAt: string
  live: boolean
  closedAt: string | null
  closeReason: string | null
  previousClaimIds: string[]
  supersededByClaimId: string | null
}

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

const idForMode = (id: string, mode: 'local' | 'hosted'): number | string =>
  mode === 'local' ? Number(id) : id

const stringId = (value: number | string | null) => (value === null ? null : String(value))

function localPostResult(value: ReturnType<typeof postNotice>): BoardPostResult {
  return {
    id: String(value.id),
    dropped: value.dropped,
    reached: value.reached,
    warning: value.warning ?? null,
  }
}

function hostedMessage(value: HostedBoardMessage): BoardMessageResult {
  return { ...value, text: null }
}

function localThread(value: ReturnType<typeof readThread>): BoardThreadResult {
  return {
    root: {
      ...value.root,
      id: String(value.root.id),
      threadRootId: null,
      acceptedReplyId: stringId(value.root.acceptedReplyId),
      noteId: stringId(value.root.noteId),
      revision: null,
      scopeProjectIds: null,
      recipientUserIds: null,
      claimId: null,
      authorUserId: null,
      authorSession: value.root.origin.session,
      ackRequired: null,
      ackDeadline: null,
      text: null,
    },
    replies: value.replies.map((reply) => ({ ...reply, id: String(reply.id) })),
  }
}

function hostedThread(value: HostedBoardThread): BoardThreadResult {
  return { root: hostedMessage(value.root), replies: value.replies }
}

function claimResult(value: ClaimView | HostedBoardClaim): BoardClaimResult {
  return {
    ...value,
    id: String(value.id),
    runId: stringId(value.runId),
    previousClaimIds: value.previousClaimIds.map(String),
    supersededByClaimId: stringId(value.supersededByClaimId),
  }
}

function localStatus(value: ReturnType<typeof noticeStatus>, clock: number): BoardStatusResult {
  const row = value.row
  return {
    message: {
      id: String(value.message.id),
      kind: row.kind,
      threadRootId: stringId(row.thread_root_id),
      title: row.title,
      body: row.body,
      audience: row.audience,
      origin: boardOrigin(row),
      senderTags: value.tags
        .filter((tag) => tag.origin === 'sender')
        .map(({ kind, value }) => ({ kind, value })),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      withdrawnAt: row.withdrawn_at,
      state: boardThreadState({
        acceptedReplyId: row.accepted_reply_id,
        withdrawnAt: row.withdrawn_at,
        expiresAt: row.expires_at,
        clock,
      }),
      acceptedReplyId: stringId(row.accepted_reply_id),
      acceptedBy: row.accepted_by,
      acceptedAt: row.accepted_at,
      noteId: stringId(row.note_id),
      notePendingError: row.note_pending_error,
      revision: null,
      scopeProjectIds: null,
      recipientUserIds: null,
      claimId: null,
      authorUserId: null,
      authorSession: row.author_session,
      ackRequired: row.ack_required === 1,
      ackDeadline: row.ack_deadline,
      text: value.message.text,
    },
    receipts: value.receipts.map((receipt) => ({
      messageId: String(value.message.id),
      readerUserId: null,
      readerSession: receipt.reader_session,
      audienceAtPosting: receipt.audience_at_posting === 1,
      deliveredAt: receipt.delivered_at,
      acknowledgedAt: receipt.acknowledged_at,
    })),
    reached: value.reached,
    acknowledged: value.acknowledged,
    unacknowledged: value.unacknowledged,
  }
}

export function hostedBoardStatusResult(
  message: HostedBoardMessage,
  receipts: HostedBoardReceipt[] = [],
): BoardStatusResult {
  return {
    message: hostedMessage(message),
    receipts: receipts.map((receipt) => ({ ...receipt })),
    reached: receipts.length,
    acknowledged: receipts.filter((receipt) => receipt.acknowledgedAt !== null).length,
    unacknowledged: message.ackRequired
      ? receipts
          .filter((receipt) => receipt.acknowledgedAt === null)
          .map((receipt) => receipt.readerSession)
          .sort()
      : [],
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
  const actor = boardActor(c.env)
  const refusal = acknowledgementRefusal({
    ackRequired: Boolean(input.ackRequired),
    audience: parseAudience(input.audience),
    authorKind: actor.kind,
    authorProject: actor.kind === 'architect' ? (projectAt(c.cwd)?.name ?? null) : null,
  })
  if (refusal) throw new Error(refusal)
  if (boardMode(locality(input.audience), c.env) === 'local')
    return localPostResult(postNotice(input, c.env, c.clock, c.cwd))
  const row = await hostedClient(c).postBoardMessage(hostedPostInput('notice', input, c))
  return { id: row.id, dropped: false, reached: null, warning: null } satisfies BoardPostResult
}

export async function boardAsk(
  input: Omit<PostNoticeInput, 'ackRequired' | 'deadlineMs' | 'suggestingRunId'>,
  inputContext?: Context,
) {
  const c = context(inputContext)
  if (boardMode(locality(input.audience), c.env) === 'local')
    return localPostResult(askQuestion(input, c.env, c.clock, c.cwd))
  const row = await hostedClient(c).postBoardMessage(hostedPostInput('question', input, c))
  return { id: row.id, dropped: false, reached: null, warning: null } satisfies BoardPostResult
}

export async function boardReply(id: string, body: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, 'board thread id', c.env)
  const parsed = idForMode(id, mode)
  if (mode === 'local') {
    const result = replyToThread(parsed as number, body, c.env, c.clock, c.cwd)
    return {
      id: String(result.id),
      rootId: String(result.rootId),
      dropped: result.dropped,
      reached: result.reached,
      warning: null,
    } satisfies BoardReplyResult
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
  return {
    id: row.id,
    rootId: id,
    dropped: false,
    reached: null,
    warning: null,
  } satisfies BoardReplyResult
}

export async function boardThread(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, 'board thread id', c.env)
  const parsed = idForMode(id, mode)
  return mode === 'local'
    ? localThread(readThread(parsed as number, c.env, c.clock))
    : hostedThread(await hostedClient(c).getBoardThread(parsed as string))
}

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
    return { noteId: String(filed.noteId), notePendingError: null, retry: null }
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
  const mode = boardModeForId(questionId, 'board question id', c.env)
  const replyMode = boardModeForId(replyId, 'board reply id', c.env)
  if (replyMode !== mode)
    throw new Error('board question id and board reply id must refer to rows in the same store')
  const question = idForMode(questionId, mode)
  const reply = idForMode(replyId, mode)
  if (mode === 'local') {
    const value = await acceptAnswer(question as number, reply as number, c.env, c.clock, c.cwd)
    return {
      ...value,
      accepted: String(value.accepted),
      questionId: String(value.questionId),
      noteId: stringId(value.noteId),
    }
  }
  const thread = await hostedClient(c).acceptBoardAnswer(question as string, {
    replyId: reply as string,
    authorSession: boardActor(c.env).session,
  })
  return { accepted: replyId, questionId, ...(await fileHostedNote(questionId, thread, c)) }
}

export async function boardFileNote(questionId: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(questionId, 'board question id', c.env)
  const question = idForMode(questionId, mode)
  if (mode === 'local') {
    const result = await fileAnswerNote(question as number, c.env, c.cwd)
    return { ...result, questionId, noteId: stringId(result.noteId) }
  }
  return {
    questionId,
    ...(await fileHostedNote(questionId, await hostedClient(c).getBoardThread(questionId), c)),
  }
}

export async function boardWithdraw(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, undefined, c.env)
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
  const mode = boardModeForId(id, undefined, c.env)
  const parsed = idForMode(id, mode)
  if (mode === 'local') acknowledgeNotice(parsed as number, c.env, c.clock)
  else {
    const session = boardActor(c.env).session ?? OPERATOR_READER
    // An acknowledged receipt never escalates; uncached legacy rows safely use true.
    await hostedClient(c).putBoardReceipt({
      messageId: parsed as string,
      readerSession: session,
      audienceAtPosting: cachedAudienceAtPosting(parsed as string, session) ?? true,
      acknowledged: true,
    })
  }
  return { acknowledged: id }
}

export async function boardStatus(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, undefined, c.env)
  const parsed = idForMode(id, mode)
  return mode === 'hosted'
    ? await hostedClient(c)
        .getBoardStatus(parsed as string)
        .then((status: HostedBoardStatus) =>
          hostedBoardStatusResult(status.message, status.receipts),
        )
    : localStatus(noticeStatus(parsed as number, c.env, c.clock), c.clock)
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
  if (boardMode('shared', c.env) === 'local') {
    const result = takeClaim(input, c.env, c.clock, c.cwd)
    return { ...claimResult(result), action: result.action }
  }
  if (input.force)
    throw new Error(
      'hosted claim take does not support --force; release the conflicting claim or wait for its lease',
    )
  const row = await hostedClient(c).takeBoardClaim({
    id: newRecordId(),
    project: claimProject(input.project, c.env, c.cwd),
    subject: input.subject,
    durationMs: input.durationMs ?? BOARD_CLAIM_DEFAULT_MS,
    runId: hostedClaimRunId(input.runId, c.env),
    note: input.note,
    holderSession: boardActor(c.env).session,
  })
  return { ...claimResult(row), action: row.action }
}

export async function boardClaimRenew(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, 'board claim id', c.env)
  const parsed = idForMode(id, mode)
  return mode === 'local'
    ? claimResult(renewClaim(parsed as number, c.env, c.clock))
    : claimResult(
        await hostedClient(c).renewBoardClaim(parsed as string, {
          holderSession: boardActor(c.env).session,
        }),
      )
}
export async function boardClaimRelease(id: string, inputContext?: Context) {
  const c = context(inputContext)
  const mode = boardModeForId(id, 'board claim id', c.env)
  const parsed = idForMode(id, mode)
  return mode === 'local'
    ? claimResult(releaseClaim(parsed as number, c.env, c.clock))
    : claimResult(
        await hostedClient(c).releaseBoardClaim(parsed as string, {
          holderSession: boardActor(c.env).session,
        }),
      )
}
export async function boardClaimList(
  project: string | undefined,
  all = false,
  inputContext?: Context,
) {
  const c = context(inputContext)
  if (boardMode('shared', c.env) === 'local')
    return { claims: listClaims(project, all, c.env, c.clock, c.cwd).claims.map(claimResult) }
  const hosted = await hostedClient(c).listBoardClaims(claimProject(project, c.env, c.cwd))
  return {
    claims: (all ? hosted.claims : hosted.claims.filter((claim) => claim.live)).map(claimResult),
  }
}
export async function boardClaimReleaseTask(key: string, project: string, inputContext?: Context) {
  const c = context(inputContext)
  return boardMode('shared', c.env) === 'local'
    ? releaseTaskClaims(key, project, c.env, c.clock)
    : hostedClient(c).releaseBoardTaskClaims({ key, project })
}
