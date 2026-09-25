// concern: ruling-file
/** Files an answered ruling as a doc or canon-proposal note. Must not know CLI grammar. */

import { FILING_DOC_SCOPES, type FilingDocScope, resolveDocSubject } from '../../../shared/docs.ts'
import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { auditQuestionMutation, authorizeWorkflowQuestionMutation } from './question-mutation.ts'
import { questionRulingRemedy } from './question-ruling-remedy.ts'
import { answererKindFromAnsweredBy } from './question-vocabulary.ts'
import {
  effectiveRuling,
  type FiledRulingKind,
  fileRulingDecision,
} from './ruling-file-authority.ts'
import {
  filedDocRef,
  parseFiledNoteId,
  renderCanonProposalNote,
  renderRulingFileText,
  rulingDocSlug,
  shortRulingTitle,
} from './ruling-file-text.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  type RootAuthority,
  runMutationActor,
} from './run-authority.ts'

type RulingFileAs = 'doc' | 'canon'

type RulingFileDoc = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'demand'
  reason: string
}

export type RulingFileStores = {
  writeDoc: (input: RulingFileDoc) => Promise<{ id: number; revision: string | null }>
  fileNote: (
    input: { text: string; new: boolean },
    options?: { cwd?: string },
  ) => Promise<{ output: string }>
}

export type FileRulingInput = {
  questionId: number
  as: RulingFileAs
  scope?: string
  subject?: string
  title?: string
  fromOperator: boolean
  channel: AnswerChannel
  dashboardAuthorized?: boolean
}

type QuestionRow = {
  id: number
  run_id: number | null
  root_id: number | null
  workflow_cursor_id: number | null
  workflow_slug: string | null
  mode_slug: string | null
  workflow_owner: string | null
  question: string
  answer: string | null
  answered_at: string | null
  answered_by: string | null
  answerer_kind: string | null
  overturned_at: string | null
  overturned_by: string | null
  replacement: string | null
  filed_as: string | null
  filed_ref: string | null
  filed_at: string | null
  repo: string | null
  cwd: string | null
  launch_key: string | null
  project_path: string | null
  args: string | null
}

function requestedKind(as: RulingFileAs): FiledRulingKind {
  return as === 'canon' ? 'canon-proposal' : 'doc'
}

function filingScope(scope: string | undefined): FilingDocScope {
  const value = scope ?? 'project'
  if ((FILING_DOC_SCOPES as readonly string[]).includes(value)) return value as FilingDocScope
  throw new Error(`unknown doc scope "${value}"; valid scopes: ${FILING_DOC_SCOPES.join(', ')}`)
}

function decideFiling(
  row: QuestionRow,
  authority: Pick<RootAuthority, 'owner' | 'actor'>,
  input: FileRulingInput,
  requested: FiledRulingKind,
) {
  return fileRulingDecision({
    answeredAt: row.answered_at,
    overturnedAt: row.overturned_at,
    replacement: row.replacement,
    filedAs: row.filed_as,
    requested,
    scope: input.scope,
    owner: authority.owner,
    actor: authority.actor,
    fromOperator: input.fromOperator,
    channel: input.channel,
    sessionIdPresent: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
    depthPresent: process.env.ORCH_DEPTH !== undefined,
    dashboardAuthorized: input.dashboardAuthorized ?? dashboardCapabilityAuthorized(),
    runProject: row.repo,
    subject: input.subject,
    workflowAuthority:
      row.run_id === null ? { operator: input.fromOperator || input.channel === 'ui' } : undefined,
  })
}

function refusal(
  row: QuestionRow,
  authority: Pick<RootAuthority, 'owner' | 'actor'>,
  decision: ReturnType<typeof fileRulingDecision>,
): string | null {
  if (decision.kind === 'allow') return null
  if (decision.code === 'unanswered') {
    return (
      `question ${row.id} is unanswered and has no ruling to file; ` +
      `record its ruling first with ${questionRulingRemedy(row)}`
    )
  }
  if (decision.code === 'overturned-without-replacement') {
    return (
      `question ${row.id} was overturned without a replacement; ` +
      `file the replacement first with orch ruling overturn ${row.id} --because ... --replacement "<ruling>"`
    )
  }
  if (decision.code === 'already-filed') {
    return (
      `question ${row.id} is already filed as ${row.filed_as} at ${row.filed_ref}; ` +
      `inspect that filing rather than filing again`
    )
  }
  if (decision.code === 'canon-direct') {
    return `canon is never written directly; file a canon proposal with orch ruling file ${row.id} --as canon`
  }
  if (decision.code === 'operator-attribution') return '--channel ui requires --from-operator'
  if (decision.code === 'dashboard-capability') {
    return '--channel ui requires the hub dashboard capability'
  }
  if (decision.code === 'session-marker') {
    return `--channel ui is refused when ${decision.actor} is set`
  }
  if (decision.code === 'foreign-project') {
    return (
      `${row.run_id === null ? `workflow cursor ${row.workflow_cursor_id}` : `run ${row.root_id}`} belongs to project ${row.repo ?? 'none'}; ` +
      `the owner path files within the run's own project. ` +
      `Pass --from-operator to file under another scope or subject`
    )
  }
  return (
    `${row.run_id === null ? `workflow cursor ${row.workflow_cursor_id}` : `run ${row.root_id}`} is owned by session ${decision.owner ?? authority.owner}; ` +
    `current session ${decision.actor ?? authority.actor ?? 'no session identity is present'} cannot file its ruling`
  )
}

function loadQuestion(questionId: number): QuestionRow {
  const row = db()
    .query(
      `SELECT q.id, q.run_id, COALESCE(r.parent_run_id, r.id) root_id,
              q.workflow_cursor_id,c.workflow_slug,c.mode_slug,c.session_id workflow_owner,
              q.question, q.answer,
              q.answered_at, q.answered_by, q.answerer_kind, q.overturned_at, q.overturned_by,
              q.replacement, q.filed_as, q.filed_ref, q.filed_at,
              COALESCE(r.repo,c.project) repo, COALESCE(r.cwd,p.path) cwd,c.args,
              COALESCE(r.launch_key,q.workflow_key) launch_key,p.path project_path
         FROM question q LEFT JOIN run r ON r.id = q.run_id
         LEFT JOIN workflow_cursor c ON c.id=q.workflow_cursor_id
         LEFT JOIN project p ON p.name=c.project AND p.retired_at IS NULL
         WHERE q.id=?`,
    )
    .get(questionId) as QuestionRow | null
  if (!row) throw new Error(`no question ${questionId}; inspect question ids with orch inbox --all`)
  return row
}

function answererKind(row: QuestionRow): string | null {
  if (row.overturned_at !== null) {
    return answererKindFromAnsweredBy(row.overturned_by) ?? row.answerer_kind
  }
  return row.answerer_kind
}

function docSubject(
  scope: FilingDocScope,
  explicit: string | undefined,
  repo: string | null,
): string | null {
  return resolveDocSubject(scope, explicit, repo)
}

async function writeDocFiling(
  input: FileRulingInput,
  row: QuestionRow,
  body: string,
  stores: RulingFileStores,
): Promise<string> {
  const scope = filingScope(input.scope)
  const title = input.title?.trim() || shortRulingTitle(row.question)
  const saved = await stores.writeDoc({
    scope,
    subject: docSubject(scope, input.subject, row.repo),
    slug: rulingDocSlug(title, row.id),
    title,
    body,
    delivery: 'demand',
    reason: `file ruling ${row.id}`,
  })
  return filedDocRef(saved.id, saved.revision)
}

async function writeCanonProposal(
  row: QuestionRow,
  body: string,
  stores: RulingFileStores,
): Promise<string> {
  if (row.run_id === null && !row.project_path) {
    throw new Error(
      `workflow project ${row.repo ?? 'unknown'} is not registered; register it with orch project add before filing a canon proposal`,
    )
  }
  const filed = await stores.fileNote(
    { text: renderCanonProposalNote(body), new: true },
    row.cwd ? { cwd: row.cwd } : undefined,
  )
  return String(parseFiledNoteId(filed.output))
}

function recordFiling(row: QuestionRow, requested: FiledRulingKind, filedRef: string, at: string) {
  const changed = db()
    .query(
      `UPDATE question SET filed_as=?, filed_ref=?, filed_at=?
        WHERE id=? AND filed_as IS NULL`,
    )
    .run(requested, filedRef, at, row.id)
  if (changed.changes === 1) return
  const current = db().query('SELECT filed_as, filed_ref FROM question WHERE id=?').get(row.id) as {
    filed_as: string | null
    filed_ref: string | null
  } | null
  if (current?.filed_as) {
    throw new Error(
      `question ${row.id} is already filed as ${current.filed_as} at ${current.filed_ref}; ` +
        `inspect that filing rather than filing again`,
    )
  }
  throw new Error(`question ${row.id} changed before it was filed`)
}

export async function fileRuling(input: FileRulingInput, stores: RulingFileStores) {
  writableDb()
  const row = loadQuestion(input.questionId)
  const requested = requestedKind(input.as)
  if (requested === 'doc' && (input.scope ?? 'project') !== 'canon') filingScope(input.scope)
  const actor = sessionId()
  let authority: RootAuthority | null = row.run_id === null ? null : runMutationActor(row.run_id)
  const questionAuthority = authority ?? { owner: row.workflow_owner, actor }
  if (row.run_id === null)
    authorizeWorkflowQuestionMutation({
      owner: row.workflow_owner,
      actor,
      fromOperator: input.fromOperator,
      subject: `workflow cursor ${row.workflow_cursor_id}`,
      action: 'file',
    })
  const decision = decideFiling(row, questionAuthority, input, requested)
  const denied = refusal(row, questionAuthority, decision)
  if (denied) throw new Error(denied)
  if (decision.kind === 'allow' && decision.operator && input.channel === 'ui') {
    if (authority) authority = { ...authority, actor: 'operator:ui' }
  }
  const ruling = effectiveRuling({
    answer: row.answer,
    overturnedAt: row.overturned_at,
    replacement: row.replacement,
  })
  if (!ruling) {
    throw new Error(
      `question ${row.id} has no effective ruling to file; ` +
        `record its ruling first with ${questionRulingRemedy(row)}`,
    )
  }
  const at = nowIso()
  const body = renderRulingFileText({
    question: row.question,
    ruling,
    answererKind: answererKind(row),
    runId: row.run_id,
    workflow:
      row.workflow_cursor_id === null
        ? null
        : {
            slug: row.workflow_slug!,
            mode: row.mode_slug!,
            cursorId: row.workflow_cursor_id,
          },
    taskKey: row.launch_key,
    date: at,
    questionId: row.id,
  })
  const filedRef =
    requested === 'canon-proposal'
      ? await writeCanonProposal(row, body, stores)
      : await writeDocFiling(input, row, body, stores)
  writeTransaction(() => {
    if (row.run_id !== null) authority = adoptRunMutation(authority!, 'file')
    recordFiling(row, requested, filedRef, at)
    if (row.run_id !== null) auditRunMutation(authority!, 'file', `as ${requested}`)
    else
      auditQuestionMutation({
        questionId: row.id,
        action: 'file',
        actor,
        at,
        reason: `as ${requested}`,
      })
  })
  return {
    question_id: row.id,
    filed_as: requested,
    filed_ref: filedRef,
    filed_at: at,
  }
}
