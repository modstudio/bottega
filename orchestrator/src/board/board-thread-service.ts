import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { nextEntityNumber } from '../database/entity-number.ts'
import { projectAt } from '../project/projects.ts'
import {
  type AnswerNoteFiler,
  acceptedAnswerNoteText,
  fileAcceptedAnswerNote,
} from './board-answer-note.ts'
import {
  architectIdentity,
  BOARD_BODY_MAX_CHARS,
  BOARD_DUPLICATE_WINDOW_MS,
  OPERATOR_READER,
  parseAudience,
} from './board-policy.ts'
import { type ReplyAudienceOption, resolveReplyReaders } from './board-reply-audience.ts'
import {
  addressed,
  authorWindowDecision,
  BOARD_MESSAGE_COLUMNS,
  boardActor,
  boardOrigin,
  hasReceipt,
  insertRootMessage,
  type MessageRow,
  messageRows,
  messageTags,
  originText,
  type PostNoticeInput,
  rowIsLive,
  validateRunAudience,
} from './board-store.ts'
import {
  acceptRefusal,
  BOARD_NOTE_FILING_LEASE_MS,
  boardThreadState,
  noteFilingLeaseDecision,
  replyRefusal,
} from './board-thread-policy.ts'

type Environment = Record<string, string | undefined>

const authorReader = (row: MessageRow) => row.author_session ?? OPERATOR_READER

function message(recordId: string): MessageRow {
  const row = messageRows().find((candidate) => candidate.record_id === recordId)
  if (!row) throw new Error(`no board message ${recordId}; choose an existing board message UUID`)
  return row
}

function threadRoot(recordId: string): MessageRow {
  const row = message(recordId)
  return row.kind === 'reply' ? message(row.thread_root_record_id!) : row
}

function replyingProject(actor: ReturnType<typeof boardActor>, cwd: string) {
  const project = actor.kind === 'architect' ? projectAt(cwd) : null
  if (actor.kind === 'architect' && !project)
    throw new Error(
      `architect replying project is unknown for ${cwd}; reply from a registered project or run ${PLATFORM_SLUG} project add first`,
    )
  return project
}

export function askQuestion(
  input: Omit<PostNoticeInput, 'ackRequired' | 'deadlineMs' | 'suggestingRunId'>,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
) {
  const database = writableDb()
  return writeTransaction(
    () => insertRootMessage('question', input, env, clock, cwd, database),
    database,
  )
}

type ReplyResult = {
  recordId: string
  number: number
  rootRecordId: string
  dropped: boolean
  reached: number
}

function addReplyReceipts(
  root: MessageRow,
  replyRecordId: string,
  reader: string,
  audience: ReplyAudienceOption | null,
  database: ReturnType<typeof writableDb>,
): number {
  const earlierAuthors = database
    .query(
      `SELECT author_session,author_kind FROM board_message
       WHERE thread_root_record_id=? AND record_id<>? ORDER BY created_at,number`,
    )
    .all(root.record_id, replyRecordId) as {
    author_session: string | null
    author_kind: string
  }[]
  const rootReceipts = database
    .query(
      `SELECT reader_session,audience_at_posting,acknowledged_at FROM board_receipt
       WHERE message_record_id=? ORDER BY rowid`,
    )
    .all(root.record_id) as Array<{
    reader_session: string
    audience_at_posting: number
    acknowledged_at: string | null
  }>
  const recipients = resolveReplyReaders({
    rootAuthor: authorReader(root),
    threadAuthors: earlierAuthors.map((row) => row.author_session ?? OPERATOR_READER),
    rootReceipts: rootReceipts.map((receipt) => ({
      reader: receipt.reader_session,
      audienceAtPosting: receipt.audience_at_posting === 1,
      acknowledged: receipt.acknowledged_at !== null,
    })),
    audience,
    replier: reader,
  })
  const addReceipt = database.query(
    `INSERT INTO board_receipt
     (message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
     VALUES (?,?,1,NULL,NULL,?)`,
  )
  for (const recipient of recipients) addReceipt.run(replyRecordId, recipient, newRecordId())
  return recipients.length
}

export function replyToThread(
  recordId: string,
  body: string,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
  audience: ReplyAudienceOption | null = null,
): ReplyResult {
  if (!body.trim()) throw new Error('board reply body is required; provide --body')
  if (body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board reply body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(body))
    throw new Error('board reply contains secret-shaped text; remove the credential and retry')
  const actor = boardActor(env)
  const reader = actor.session ?? OPERATOR_READER
  const database = writableDb()
  return writeTransaction(() => {
    const root = threadRoot(recordId)
    if (audience?.startsWith('run:')) validateRunAudience(parseAudience(audience), actor, database)
    const refusal = replyRefusal({
      actor: { kind: actor.kind, reader },
      root: {
        id: root.number,
        kind: root.kind,
        authorReader: authorReader(root),
        audienceKind: root.audience ? parseAudience(root.audience).kind : 'operator',
        live: rowIsLive(root, clock),
        accepted: root.accepted_reply_record_id !== null,
      },
      addressed: addressed(root, reader, clock),
      hasReceipt: hasReceipt(root.record_id, reader),
    })
    if (refusal) throw new Error(refusal)
    const duplicate = database
      .query(
        `SELECT record_id,number FROM board_message
         WHERE kind='reply' AND author_kind=? AND author_session IS ?
           AND thread_root_record_id=? AND body=? AND audience IS ? AND created_at>=?
         ORDER BY created_at DESC,number DESC LIMIT 1`,
      )
      .get(
        actor.kind,
        actor.session,
        root.record_id,
        body,
        audience,
        new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString(),
      ) as { record_id: string; number: number } | null
    const decision = authorWindowDecision(actor, clock, Boolean(duplicate), database)
    if (decision === 'drop-duplicate') {
      const reached = (
        database
          .query('SELECT COUNT(*) n FROM board_receipt WHERE message_record_id=?')
          .get(duplicate!.record_id) as { n: number }
      ).n
      return {
        recordId: duplicate!.record_id,
        number: duplicate!.number,
        rootRecordId: root.record_id,
        dropped: true,
        reached,
      }
    }
    if (decision === 'rate-limited')
      throw new Error('board post rate limit reached; retry after the ten-minute author window')
    const identity = actor.kind === 'architect' ? architectIdentity(env) : null
    const project = replyingProject(actor, cwd)
    const createdAt = new Date(clock).toISOString()
    const replyRecordId = newRecordId()
    const replyNumber = nextEntityNumber(database, 'board_message')
    database
      .query(
        `INSERT INTO board_message
         (record_id,number,kind,author_kind,author_session,author_run_record_id,author_harness,author_project,author_project_record_id,
          audience,title,body,ack_required,ack_deadline,expires_at,created_at,withdrawn_at,
          thread_root_record_id)
         VALUES (?,?,'reply',?,?,NULL,?,?,?,?,NULL,?,0,NULL,NULL,?,NULL,?)`,
      )
      .run(
        replyRecordId,
        replyNumber,
        actor.kind,
        actor.session,
        identity?.harness ?? null,
        project?.name ?? null,
        project?.recordId ?? null,
        audience,
        body,
        createdAt,
        root.record_id,
      )
    const reached = addReplyReceipts(root, replyRecordId, reader, audience, database)
    return {
      recordId: replyRecordId,
      number: replyNumber,
      rootRecordId: root.record_id,
      dropped: false,
      reached,
    }
  }, database)
}

export function readThread(recordId: string, env: Environment = process.env, clock = Date.now()) {
  const actor = boardActor(env)
  const reader = actor.session ?? OPERATOR_READER
  const root = threadRoot(recordId)
  if (
    actor.kind !== 'operator' &&
    authorReader(root) !== reader &&
    !addressed(root, reader, clock) &&
    !hasReceipt(root.record_id, reader)
  )
    throw new Error(`board thread ${root.number} is not readable by this session`)
  const replies = db()
    .query(
      `SELECT ${BOARD_MESSAGE_COLUMNS} FROM board_message WHERE thread_root_record_id=? ORDER BY created_at,number`,
    )
    .all(root.record_id) as MessageRow[]
  const state = boardThreadState({
    acceptedReplyId: root.accepted_reply_record_id,
    withdrawnAt: root.withdrawn_at,
    expiresAt: root.expires_at,
    clock,
  })
  return {
    root: {
      recordId: root.record_id,
      number: root.number,
      kind: root.kind,
      purpose: root.purpose,
      title: root.title,
      body: root.body,
      audience: root.audience,
      origin: boardOrigin(root),
      senderTags: messageTags(root.record_id)
        .filter((tag) => tag.origin === 'sender')
        .map(({ kind, value }) => ({ kind, value })),
      createdAt: root.created_at,
      expiresAt: root.expires_at,
      withdrawnAt: root.withdrawn_at,
      state,
      acceptedReplyId: root.accepted_reply_record_id,
      acceptedBy: root.accepted_by,
      acceptedAt: root.accepted_at,
      noteRecordId: root.note_record_id,
      noteLabel: root.note_label,
      notePendingError: root.note_pending_error,
    },
    replies: replies.map((reply) => ({
      recordId: reply.record_id,
      number: reply.number,
      body: reply.body,
      origin: boardOrigin(reply),
      createdAt: reply.created_at,
    })),
  }
}

function retryHint(questionId: number, pendingError: string | null): string | null {
  return pendingError ? `${PLATFORM_SLUG} board file-note ${questionId}` : null
}

function filingLeaseRefusal(question: MessageRow, clock: number): string | null {
  const decision = noteFilingLeaseDecision(
    question.note_record_id ?? question.note_label,
    question.note_filing_started_at,
    clock,
  )
  if (decision.kind === 'filed')
    return `board question ${question.number} already filed note ${question.note_label}`
  if (decision.kind === 'in-progress')
    return `board question ${question.number} note filing is in progress; retry with ${PLATFORM_SLUG} board file-note ${question.number} after ${new Date(decision.retryAt).toISOString()}`
  return null
}

function takeFilingLease(
  questionId: string,
  clock: number,
): { question: MessageRow; reply: MessageRow; startedAt: string } {
  const database = writableDb()
  return writeTransaction(() => {
    const current = message(questionId)
    const refusal = filingLeaseRefusal(current, clock)
    if (refusal) throw new Error(refusal)
    const startedAt = new Date(clock).toISOString()
    const staleBefore = new Date(clock - BOARD_NOTE_FILING_LEASE_MS).toISOString()
    const taken = database
      .query(
        `UPDATE board_message SET note_filing_started_at=?
         WHERE record_id=? AND note_record_id IS NULL AND note_label IS NULL
           AND (note_filing_started_at IS NULL OR note_filing_started_at<=?)`,
      )
      .run(startedAt, questionId, staleBefore)
    if (taken.changes !== 1) {
      const raced = message(questionId)
      throw new Error(
        filingLeaseRefusal(raced, clock) ??
          `board question ${questionId} note filing is in progress; retry with ${PLATFORM_SLUG} board file-note ${questionId}`,
      )
    }
    const question = message(questionId)
    return { question, reply: message(question.accepted_reply_record_id!), startedAt }
  }, database)
}

async function filePendingNote(
  questionId: string,
  cwd: string,
  filer: AnswerNoteFiler,
  clock: number,
): Promise<{
  noteRecordId: string | null
  noteLabel: string | null
  notePendingError: string | null
  retry: string | null
}> {
  const { question, reply, startedAt } = takeFilingLease(questionId, clock)
  try {
    const filed = await filer(
      {
        text: acceptedAnswerNoteText({
          title: question.title ?? '',
          replyBody: reply.body,
          askerOrigin: originText(boardOrigin(question)),
          answererOrigin: originText(boardOrigin(reply)),
        }),
        new: true,
      },
      { cwd },
    )
    if (filed.noteRecordId === null || filed.noteLabel === null)
      throw new Error('hub did not report the filed note identity')
    const database = writableDb()
    writeTransaction(() => {
      database
        .query(
          `UPDATE board_message
           SET note_record_id=?,note_label=?,note_pending_error=NULL,note_filing_started_at=NULL
           WHERE record_id=? AND note_filing_started_at=?`,
        )
        .run(filed.noteRecordId, filed.noteLabel, question.record_id, startedAt)
    }, database)
    return {
      noteRecordId: filed.noteRecordId,
      noteLabel: filed.noteLabel,
      notePendingError: null,
      retry: null,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const database = writableDb()
    writeTransaction(() => {
      database
        .query(
          `UPDATE board_message
           SET note_pending_error=?,note_filing_started_at=NULL
           WHERE record_id=? AND note_filing_started_at=?`,
        )
        .run(detail, question.record_id, startedAt)
    }, database)
    return {
      noteRecordId: null,
      noteLabel: null,
      notePendingError: detail,
      retry: retryHint(question.number, detail),
    }
  }
}

export async function acceptAnswer(
  questionId: string,
  replyId: string,
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
      questionId: question.number,
      questionKind: question.kind,
      authorReader: authorReader(question),
      accepted: question.accepted_reply_record_id !== null,
      live: rowIsLive(question, clock),
    })
    if (refusal) throw new Error(refusal)
    const reply = message(replyId)
    if (reply.kind !== 'reply' || reply.thread_root_record_id !== question.record_id)
      throw new Error(`board reply ${replyId} does not belong to board question ${questionId}`)
    database
      .query(
        `UPDATE board_message
         SET accepted_reply_record_id=?,accepted_by=?,accepted_at=?,note_pending_error=? WHERE record_id=?`,
      )
      .run(
        reply.record_id,
        reader,
        new Date(clock).toISOString(),
        `note filing has not completed; retry with ${PLATFORM_SLUG} board file-note ${question.number}`,
        question.record_id,
      )
    return { question: message(question.record_id), reply }
  }, database)
  const note = await filePendingNote(question.record_id, cwd, filer, clock)
  return { accepted: reply.record_id, questionId: question.record_id, ...note }
}

export async function fileAnswerNote(
  questionId: string,
  env: Environment = process.env,
  cwd = process.cwd(),
  filer: AnswerNoteFiler = fileAcceptedAnswerNote,
  clock = Date.now(),
) {
  const actor = boardActor(env)
  const question = message(questionId)
  if (question.kind !== 'question' || question.accepted_reply_record_id === null)
    throw new Error(`board question ${questionId} has no accepted answer to file`)
  if (actor.kind !== 'operator' && actor.session !== question.author_session)
    throw new Error(
      `only the question author or operator may file the answer note for board question ${questionId}`,
    )
  const refusal = filingLeaseRefusal(question, clock)
  if (refusal) throw new Error(refusal)
  const note = await filePendingNote(question.record_id, cwd, filer, clock)
  return { questionId, ...note }
}
