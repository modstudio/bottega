// concern: board-suggestions
import { BOARD_DEFAULT_EXPIRY_MS } from '../../../shared/board-duration.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import {
  BOARD_BODY_MAX_CHARS,
  BOARD_DUPLICATE_WINDOW_MS,
  BOARD_POST_RATE_WINDOW_MS,
  BOARD_TITLE_MAX_CHARS,
  postDecision,
} from './board-policy.ts'
import { boardActor, type PostNoticeInput, postNoticeInTransaction } from './board-service.ts'
import { type BoardTag, type SenderBoardTags, senderBoardTags, senderTagKey } from './board-tags.ts'

type Environment = Record<string, string | undefined>
export type SuggestBoardPostInput = SenderBoardTags & { title: string; body: string }
export type DisposeSuggestionInput = Partial<SuggestBoardPostInput> & { audience: string }

type SuggestionRow = {
  id: number
  author_run_id: number
  audience: string
  title: string
  body: string
  withdrawn_at: string | null
}

function validateText(input: SuggestBoardPostInput): void {
  if (!input.title.trim() || !input.body.trim())
    throw new Error('board suggestion title and body are required; provide both fields')
  if (input.title.length > BOARD_TITLE_MAX_CHARS)
    throw new Error(
      `board suggestion title exceeds ${BOARD_TITLE_MAX_CHARS} characters; shorten it`,
    )
  if (input.body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board suggestion body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (
    [input.title, input.body, input.task, ...(input.paths ?? []), ...(input.topics ?? [])].some(
      (value) => value !== undefined && containsSecretShaped(value),
    )
  )
    throw new Error('board suggestion contains secret-shaped text; remove the credential and retry')
}

function rootRun(runId: number) {
  return db()
    .query(
      `SELECT root.id,root.session_id,root.repo
       FROM run turn JOIN run root ON root.id=COALESCE(turn.parent_run_id,turn.id)
       WHERE turn.id=?`,
    )
    .get(runId) as { id: number; session_id: string | null; repo: string | null } | null
}

export function suggestBoardPost(
  runId: number,
  input: SuggestBoardPostInput,
  clock = Date.now(),
): { id: number; dropped: boolean } {
  validateText(input)
  const senderTags = senderBoardTags(input)
  const run = rootRun(runId)
  if (!run) throw new Error(`run ${runId} does not exist; put the suggestion in the final reply`)
  if (!run.session_id)
    throw new Error(
      `run ${run.id} has no owning architect session; put the suggestion in the final reply instead`,
    )
  const audience = `session:${run.session_id}`
  const since = new Date(clock - BOARD_POST_RATE_WINDOW_MS).toISOString()
  const duplicateSince = new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString()
  const recentPosts = (
    db()
      .query(
        `SELECT COUNT(*) n FROM board_message
         WHERE author_kind='worker' AND author_run_id=? AND created_at>=?`,
      )
      .get(run.id, since) as { n: number }
  ).n
  const candidates = db()
    .query(
      `SELECT id FROM board_message
       WHERE kind='suggestion' AND author_kind='worker' AND author_run_id=?
         AND audience=? AND title=? AND body=? AND created_at>=? ORDER BY id DESC`,
    )
    .all(run.id, audience, input.title, input.body, duplicateSince) as { id: number }[]
  const key = senderTagKey(senderTags)
  const duplicate = candidates.find((candidate) => {
    const tags = db()
      .query(
        `SELECT kind,value FROM board_message_tag
         WHERE message_id=? AND origin='sender'`,
      )
      .all(candidate.id) as Pick<BoardTag, 'kind' | 'value'>[]
    return senderTagKey(tags) === key
  })
  const decision = postDecision({ recentPosts, duplicate: Boolean(duplicate) })
  if (decision === 'drop-duplicate') return { id: duplicate!.id, dropped: true }
  if (decision === 'rate-limited')
    throw new Error('board suggestion rate limit reached; retry after the ten-minute author window')
  const createdAt = new Date(clock).toISOString()
  const expiresAt = new Date(clock + BOARD_DEFAULT_EXPIRY_MS).toISOString()
  const database = writableDb()
  let id = 0
  writeTransaction(() => {
    id = Number(
      database
        .query(
          `INSERT INTO board_message
           (kind,author_kind,author_session,author_run_id,author_harness,author_project,
            audience,title,body,ack_required,ack_deadline,expires_at,created_at,withdrawn_at)
           VALUES ('suggestion','worker',NULL,?,NULL,?,?,?, ?,0,NULL,?,?,NULL)`,
        )
        .run(run.id, run.repo, audience, input.title, input.body, expiresAt, createdAt)
        .lastInsertRowid,
    )
    const addTag = database.query(
      `INSERT INTO board_message_tag (message_id,kind,value,origin) VALUES (?,?,?,'sender')`,
    )
    for (const tag of senderTags) addTag.run(id, tag.kind, tag.value)
  }, database)
  return { id, dropped: false }
}

function suggestion(id: number, database = db()): SuggestionRow {
  const row = database
    .query(`SELECT * FROM board_message WHERE id=? AND kind='suggestion'`)
    .get(id) as SuggestionRow | null
  if (!row) throw new Error(`no board suggestion ${id}; choose an existing suggestion id`)
  if (row.withdrawn_at)
    throw new Error(`board suggestion ${id} is already withdrawn; choose a live suggestion`)
  return row
}

function authorizeDisposal(row: SuggestionRow, env: Environment) {
  const actor = boardActor(env)
  const addressee = row.audience.slice('session:'.length)
  if (actor.kind !== 'operator' && actor.session !== addressee)
    throw new Error(
      `only session ${addressee} or the operator may dispose of board suggestion ${row.id}; use that session or an operator terminal`,
    )
  return actor
}

function senderDefaults(id: number, database = db()): SenderBoardTags {
  const tags = database
    .query(
      `SELECT kind,value FROM board_message_tag
       WHERE message_id=? AND origin='sender' ORDER BY rowid`,
    )
    .all(id) as Pick<BoardTag, 'kind' | 'value'>[]
  return {
    task: tags.find((tag) => tag.kind === 'task')?.value,
    paths: tags.filter((tag) => tag.kind === 'path').map((tag) => tag.value),
    topics: tags.filter((tag) => tag.kind === 'topic').map((tag) => tag.value),
  }
}

export function postBoardSuggestion(
  id: number,
  input: DisposeSuggestionInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
) {
  const database = writableDb()
  return writeTransaction(() => {
    const row = suggestion(id, database)
    authorizeDisposal(row, env)
    const defaults = senderDefaults(id, database)
    const notice: PostNoticeInput = {
      audience: input.audience,
      title: input.title ?? row.title,
      body: input.body ?? row.body,
      task: input.task ?? defaults.task,
      paths: input.paths ?? defaults.paths,
      topics: input.topics ?? defaults.topics,
      suggestingRunId: row.author_run_id,
    }
    const posted = postNoticeInTransaction(notice, env, clock, cwd, database)
    database
      .query('UPDATE board_message SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?')
      .run(new Date(clock).toISOString(), id)
    return posted
  }, database)
}

export function declineBoardSuggestion(
  id: number,
  env: Environment = process.env,
  clock = Date.now(),
): void {
  const database = writableDb()
  writeTransaction(() => {
    const row = suggestion(id, database)
    authorizeDisposal(row, env)
    database
      .query('UPDATE board_message SET withdrawn_at=? WHERE id=?')
      .run(new Date(clock).toISOString(), id)
  }, database)
}
