import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  acceptedAnswerNoteText,
  type AnswerNoteFiler,
  fileAcceptedAnswerNote,
} from './board-answer-note.ts'
import {
  architectIdentity,
  BOARD_BODY_MAX_CHARS,
  BOARD_DUPLICATE_WINDOW_MS,
  BOARD_POST_RATE_WINDOW_MS,
  OPERATOR_READER,
  parseAudience,
  postDecision,
} from './board-policy.ts'
import {
  addressed,
  boardActor,
  hasReceipt,
  type MessageRow,
  messageRows,
  messageTags,
  originText,
  type PostNoticeInput,
  postQuestionRoot,
  rowIsLive,
} from './board-service.ts'
import { acceptRefusal, replyRefusal, threadParticipants } from './board-thread-policy.ts'

type Environment = Record<string, string | undefined>

type Origin = {
  kind: string
  session: string | null
  harness: string | null
  project: string | null
  runId: number | null
}

const origin = (row: MessageRow): Origin => ({
  kind: row.author_kind,
  session: row.author_session,
  harness: row.author_harness,
  project: row.author_project,
  runId: row.author_run_id,
})

const authorReader = (row: MessageRow) => row.author_session ?? OPERATOR_READER

function message(id: number): MessageRow {
  const row = messageRows().find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no board message ${id}; choose an existing board message id`)
  return row
}

function threadRoot(id: number): MessageRow {
  const row = message(id)
  return row.kind === 'reply' ? message(row.thread_root_id!) : row
}

export function askQuestion(
  input: Omit<PostNoticeInput, 'ackRequired' | 'deadlineMs' | 'suggestingRunId'>,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
) {
  return postQuestionRoot(input, env, clock, cwd)
}

export function replyToThread(
  id: number,
  body: string,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): { id: number; rootId: number; dropped: boolean; reached: number } {
  if (!body.trim()) throw new Error('board reply body is required; provide --body')
  if (body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board reply body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(body))
    throw new Error('board reply contains secret-shaped text; remove the credential and retry')
  const actor = boardActor(env)
  const reader = actor.session ?? OPERATOR_READER
  const root = threadRoot(id)
  const refusal = replyRefusal({
    actor: { kind: actor.kind, reader },
    root: {
      id: root.id,
      kind: root.kind,
      authorReader: authorReader(root),
      audienceKind: root.audience ? parseAudience(root.audience).kind : 'operator',
      live: rowIsLive(root, clock),
      accepted: root.accepted_reply_id !== null,
    },
    addressed: addressed(root, reader, clock),
    hasReceipt: hasReceipt(root.id, reader),
  })
  if (refusal) throw new Error(refusal)
  const database = writableDb()
  return writeTransaction(() => {
    const since = new Date(clock - BOARD_POST_RATE_WINDOW_MS).toISOString()
    const recentPosts = (
      database
        .query(
          `SELECT COUNT(*) n FROM board_message
           WHERE author_kind=? AND author_session IS ? AND created_at>=?`,
        )
        .get(actor.kind, actor.session, since) as { n: number }
    ).n
    const duplicate = database
      .query(
        `SELECT id FROM board_message
         WHERE kind='reply' AND author_kind=? AND author_session IS ?
           AND thread_root_id=? AND body=? AND created_at>=?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(
        actor.kind,
        actor.session,
        root.id,
        body,
        new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString(),
      ) as { id: number } | null
    const decision = postDecision({ recentPosts, duplicate: Boolean(duplicate) })
    if (decision === 'drop-duplicate') {
      const reached = (
        database.query('SELECT COUNT(*) n FROM board_receipt WHERE message_id=?').get(
          duplicate!.id,
        ) as { n: number }
      ).n
      return { id: duplicate!.id, rootId: root.id, dropped: true, reached }
    }
    if (decision === 'rate-limited')
      throw new Error('board post rate limit reached; retry after the ten-minute author window')
    const identity = actor.kind === 'architect' ? architectIdentity(env) : null
    const project = actor.kind === 'architect' ? projectAt(cwd) : null
    if (actor.kind === 'architect' && !project)
      throw new Error(
        `architect replying project is unknown for ${cwd}; reply from a registered project or run orch project add first`,
      )
    const createdAt = new Date(clock).toISOString()
    const inserted = database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,author_run_id,author_harness,author_project,
          audience,title,body,ack_required,ack_deadline,expires_at,created_at,withdrawn_at,
          thread_root_id)
         VALUES ('reply',?,?,NULL,?,?,NULL,NULL,?,0,NULL,NULL,?,NULL,?)`,
      )
      .run(actor.kind, actor.session, identity?.harness ?? null, project?.name ?? null, body, createdAt, root.id)
    const replyId = Number(inserted.lastInsertRowid)
    const earlierAuthors = database
      .query(
        `SELECT author_session,author_kind FROM board_message
         WHERE thread_root_id=? AND id<>? ORDER BY created_at,id`,
      )
      .all(root.id, replyId) as { author_session: string | null; author_kind: string }[]
    const participants = threadParticipants(
      authorReader(root),
      earlierAuthors.map((row) => row.author_session ?? OPERATOR_READER),
      reader,
    )
    const addReceipt = database.query(
      `INSERT INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,1,NULL,NULL)`,
    )
    for (const participant of participants) addReceipt.run(replyId, participant)
    return { id: replyId, rootId: root.id, dropped: false, reached: participants.length }
  }, database)
}

export function readThread(
  id: number,
  env: Environment = process.env,
  clock = Date.now(),
) {
  const actor = boardActor(env)
  const reader = actor.session ?? OPERATOR_READER
  const root = threadRoot(id)
  if (
    actor.kind !== 'operator' &&
    authorReader(root) !== reader &&
    !addressed(root, reader, clock) &&
    !hasReceipt(root.id, reader)
  )
    throw new Error(`board thread ${root.id} is not readable by this session`)
  const replies = db()
    .query('SELECT * FROM board_message WHERE thread_root_id=? ORDER BY created_at,id')
    .all(root.id) as MessageRow[]
  const state = root.accepted_reply_id
    ? 'accepted'
    : root.withdrawn_at
      ? 'withdrawn'
      : root.expires_at && Date.parse(root.expires_at) <= clock
        ? 'expired'
        : 'open'
  return {
    root: {
      id: root.id,
      kind: root.kind,
      title: root.title,
      body: root.body,
      audience: root.audience,
      origin: origin(root),
      senderTags: messageTags(root.id)
        .filter((tag) => tag.origin === 'sender')
        .map(({ kind, value }) => ({ kind, value })),
      createdAt: root.created_at,
      expiresAt: root.expires_at,
      withdrawnAt: root.withdrawn_at,
      state,
      acceptedReplyId: root.accepted_reply_id,
      acceptedBy: root.accepted_by,
      acceptedAt: root.accepted_at,
      noteId: root.note_id,
      notePendingError: root.note_pending_error,
    },
    replies: replies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      origin: origin(reply),
      createdAt: reply.created_at,
    })),
  }
}

async function filePendingNote(
  question: MessageRow,
  reply: MessageRow,
  cwd: string,
  filer: AnswerNoteFiler,
): Promise<{ noteId: number | null; notePendingError: string | null }> {
  try {
    const filed = await filer(
      {
        text: acceptedAnswerNoteText({
          title: question.title ?? '',
          replyBody: reply.body,
          askerOrigin: originText(question),
          answererOrigin: originText(reply),
        }),
        new: true,
      },
      { cwd },
    )
    if (filed.noteId === null) throw new Error('hub did not report the filed note id')
    writeTransaction(() => {
      writableDb()
        .query('UPDATE board_message SET note_id=?,note_pending_error=NULL WHERE id=?')
        .run(filed.noteId, question.id)
    }, writableDb())
    return { noteId: filed.noteId, notePendingError: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    writeTransaction(() => {
      writableDb()
        .query('UPDATE board_message SET note_pending_error=? WHERE id=?')
        .run(detail, question.id)
    }, writableDb())
    return { noteId: null, notePendingError: detail }
  }
}

export async function acceptAnswer(
  questionId: number,
  replyId: number,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
  filer: AnswerNoteFiler = fileAcceptedAnswerNote,
) {
  const actor = boardActor(env)
  const reader = actor.session ?? OPERATOR_READER
  const database = writableDb()
  const { question, reply } = writeTransaction(() => {
    const question = message(questionId)
    const refusal = acceptRefusal({
      actor: { kind: actor.kind, reader },
      questionId,
      questionKind: question.kind,
      authorReader: authorReader(question),
      accepted: question.accepted_reply_id !== null,
      live: rowIsLive(question, clock),
    })
    if (refusal) throw new Error(refusal)
    const reply = message(replyId)
    if (reply.kind !== 'reply' || reply.thread_root_id !== question.id)
      throw new Error(`board reply ${replyId} does not belong to board question ${questionId}`)
    database
      .query(
        `UPDATE board_message
         SET accepted_reply_id=?,accepted_by=?,accepted_at=?,note_pending_error=? WHERE id=?`,
      )
      .run(
        reply.id,
        reader,
        new Date(clock).toISOString(),
        `note filing has not completed; retry with orch board file-note ${question.id}`,
        question.id,
      )
    return { question: message(question.id), reply }
  }, database)
  const note = await filePendingNote(question, reply, cwd, filer)
  return { accepted: reply.id, questionId: question.id, ...note }
}

export async function fileAnswerNote(
  questionId: number,
  env: Environment = process.env,
  cwd = process.cwd(),
  filer: AnswerNoteFiler = fileAcceptedAnswerNote,
) {
  boardActor(env)
  const question = message(questionId)
  if (question.kind !== 'question' || question.accepted_reply_id === null)
    throw new Error(`board question ${questionId} has no accepted answer to file`)
  if (question.note_id !== null)
    throw new Error(`board question ${questionId} already filed note ${question.note_id}`)
  const reply = message(question.accepted_reply_id)
  const note = await filePendingNote(question, reply, cwd, filer)
  return { questionId, ...note }
}
