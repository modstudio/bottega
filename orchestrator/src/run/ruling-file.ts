// concern: ruling-file
/** Files an answered ruling as a doc or canon-proposal note. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { FILING_DOC_SCOPES, type FilingDocScope, resolveDocSubject } from '../../../shared/docs.ts'
import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import {
  callerIdentity,
  db,
  nowIso,
  sessionId,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { auditQuestionMutation, authorizeWorkflowQuestionMutation } from './question-mutation.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import { questionRulingRemedy } from './question-ruling-remedy.ts'
import { answererKindFromAnsweredBy } from './question-vocabulary.ts'
import {
  effectiveRuling,
  type FiledRulingKind,
  fileRulingDecision,
} from './ruling-file-authority.ts'
import {
  filedDocRef,
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
import { RUN_MUTATION_WINDOW_MS } from './run-mutation-owner.ts'

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
  writeDoc: (
    input: RulingFileDoc,
  ) => Promise<{ id: string; revision: string; revisionNumber: number }>
  fileNote: (
    input: { text: string; new: boolean },
    options?: { cwd?: string },
  ) => Promise<{ noteRecordId: string | null; noteLabel: string | null }>
}

export type FileRulingInput = {
  questionId: string
  as: RulingFileAs
  scope?: string
  subject?: string
  title?: string
  fromOperator: boolean
  channel: AnswerChannel
  dashboardAuthorized?: boolean
}

type QuestionRow = {
  record_id: string
  number: number
  run_record_id: string | null
  root_id: string | null
  workflow_cursor_record_id: string | null
  workflow_cursor_number: number | null
  workflow_slug: string | null
  mode_slug: string | null
  workflow_owner: string | null
  workflow_updated_at: string | null
  question: string
  answer: string | null
  answer_basis: string | null
  answered_at: string | null
  answered_by: string | null
  answerer_kind: string | null
  overturned_at: string | null
  overturned_by: string | null
  replacement: string | null
  filed_as: string | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
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
  authority: RootAuthority,
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
    ownerLastSeenAt: authority.ownerLastSeenAt,
    chainLastActivityAt: authority.chainLastActivityAt,
    coordinatorRun: authority.coordinatorRun,
    now: authority.now,
    windowMs: authority.windowMs,
    fromOperator: input.fromOperator,
    channel: input.channel,
    sessionIdPresent: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
    depthPresent: process.env.BOTTEGA_DEPTH !== undefined,
    dashboardAuthorized: input.dashboardAuthorized ?? dashboardCapabilityAuthorized(),
    runProject: row.repo,
    subject: input.subject,
    workflowAuthority:
      row.run_record_id === null
        ? { operator: input.fromOperator || input.channel === 'ui' }
        : undefined,
  })
}

function refusal(
  row: QuestionRow,
  authority: RootAuthority,
  decision: ReturnType<typeof fileRulingDecision>,
): string | null {
  if (decision.kind === 'allow') return null
  if (decision.code === 'unanswered') {
    return (
      `question ${row.number} is unanswered and has no ruling to file; ` +
      `record its ruling first with ${questionRulingRemedy(row)}`
    )
  }
  if (decision.code === 'overturned-without-replacement') {
    return (
      `question ${row.number} was overturned without a replacement; ` +
      `file the replacement first with ${PLATFORM_SLUG} question ruling overturn ${row.number} --because ... --replacement "<ruling>"`
    )
  }
  if (decision.code === 'already-filed') {
    return (
      `question ${row.number} is already filed as ${row.filed_as} at ${filingDisplay(row)}; ` +
      `inspect that filing rather than filing again`
    )
  }
  if (decision.code === 'canon-direct') {
    return `canon is never written directly; file a canon proposal with ${PLATFORM_SLUG} question ruling file ${row.number} --as canon`
  }
  if (decision.code === 'operator-attribution') return '--channel ui requires --from-operator'
  if (decision.code === 'dashboard-capability') {
    return '--channel ui requires the dashboard capability'
  }
  if (decision.code === 'session-marker') {
    return `--channel ui is refused when ${decision.actor} is set`
  }
  if (decision.code === 'foreign-project') {
    return (
      `${row.run_record_id === null ? `workflow cursor ${row.workflow_cursor_record_id}` : `run ${row.root_id}`} belongs to project ${row.repo ?? 'none'}; ` +
      `the owner path files within the run's own project. ` +
      `Pass --from-operator to file under another scope or subject`
    )
  }
  return ownerRefusal(row, authority, decision)
}

function ownerRefusal(
  row: QuestionRow,
  authority: RootAuthority,
  decision: Exclude<ReturnType<typeof fileRulingDecision>, { kind: 'allow' }>,
): string {
  if (!decision.actor && !authority.actor)
    return (
      `${row.run_record_id === null ? `workflow cursor ${row.workflow_cursor_record_id}` : `run ${row.root_id}`} is owned by session ${decision.owner ?? authority.owner}; ` +
      callerIdentityRefusal(callerIdentity(), 'file its ruling')
    )
  return (
    `${row.run_record_id === null ? `workflow cursor ${row.workflow_cursor_record_id}` : `run ${row.root_id}`} is owned by session ${decision.owner ?? authority.owner}; ` +
    `current session ${decision.actor ?? authority.actor} cannot file its ruling ` +
    '(owner active within the window)'
  )
}

function loadQuestion(questionId: string): QuestionRow {
  const row = db()
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,r.record_id run_record_id,COALESCE(r.parent_run_record_id,r.record_id) root_id,
              q.workflow_cursor_record_id,c.number workflow_cursor_number,c.workflow_slug,c.mode_slug,c.session_id workflow_owner,
              c.updated_at workflow_updated_at,
              q.question, q.answer, q.answer_basis,
              q.answered_at, q.answered_by, q.answerer_kind, q.overturned_at, q.overturned_by,
              q.replacement, q.filed_as, q.filed_ref, q.filed_record_id, q.filed_label, q.filed_at,
              COALESCE(r.repo,c.project) repo, COALESCE(r.cwd,p.path) cwd,c.args,
              COALESCE(r.launch_key,q.workflow_key) launch_key,p.path project_path
         FROM question q LEFT JOIN run r ON r.record_id = q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
         LEFT JOIN project p ON p.record_id=c.project_record_id AND p.retired_at IS NULL
         WHERE q.record_id=?`,
    )
    .get(questionId) as QuestionRow | null
  if (!row)
    throw new Error(
      `no question ${questionId}; inspect question ids with ${PLATFORM_SLUG} question inbox --all`,
    )
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
): Promise<{ filed_ref: string; filed_record_id: string; filed_label: null }> {
  const scope = filingScope(input.scope)
  const title = input.title?.trim() || shortRulingTitle(row.question)
  const saved = await stores.writeDoc({
    scope,
    subject: docSubject(scope, input.subject, row.repo),
    slug: rulingDocSlug(title, row.number),
    title,
    body,
    delivery: 'demand',
    reason: `file ruling ${row.number}`,
  })
  return {
    filed_ref: filedDocRef(
      `${scope}/${docSubject(scope, input.subject, row.repo) ?? '_'}/${rulingDocSlug(title, row.number)}`,
      saved.revisionNumber,
    ),
    filed_record_id: saved.revision,
    filed_label: null,
  }
}

async function writeCanonProposal(
  row: QuestionRow,
  body: string,
  stores: RulingFileStores,
): Promise<{ filed_ref: null; filed_record_id: string; filed_label: string }> {
  if (row.run_record_id === null && !row.project_path) {
    throw new Error(
      `workflow project ${row.repo ?? 'unknown'} is not registered; register it with ${PLATFORM_SLUG} project add before filing a canon proposal`,
    )
  }
  const filed = await stores.fileNote(
    { text: renderCanonProposalNote(body), new: true },
    row.cwd ? { cwd: row.cwd } : undefined,
  )
  if (!filed.noteRecordId || !filed.noteLabel)
    throw new Error(`${PLATFORM_SLUG} note new did not report a note UUID and label`)
  return { filed_ref: null, filed_record_id: filed.noteRecordId, filed_label: filed.noteLabel }
}

type FilingReference = {
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
}

const filingResult = (
  row: QuestionRow,
  filedAs: FiledRulingKind,
  reference: FilingReference,
  filedAt: string,
) => ({
  question_id: row.number,
  question_record_id: row.record_id,
  filed_as: filedAs,
  filed_ref: reference.filed_ref,
  filed_record_id: reference.filed_record_id,
  filed_label: reference.filed_label,
  filed_at: filedAt,
})

function filingDisplay(row: FilingReference): string {
  if (row.filed_label)
    return row.filed_record_id ? `${row.filed_label} (${row.filed_record_id})` : row.filed_label
  return row.filed_ref ?? 'unknown filing'
}

function recordFiling(
  row: QuestionRow,
  requested: FiledRulingKind,
  reference: FilingReference,
  at: string,
) {
  const changed = db()
    .query(
      `UPDATE question SET filed_as=?, filed_ref=?, filed_record_id=?, filed_label=?,
         filed_at=?, revision=revision+1
        WHERE record_id=? AND filed_as IS NULL`,
    )
    .run(
      requested,
      reference.filed_ref,
      reference.filed_record_id,
      reference.filed_label,
      at,
      row.record_id,
    )
  if (changed.changes === 1) return
  const current = db()
    .query(
      'SELECT filed_as, filed_ref, filed_record_id, filed_label FROM question WHERE record_id=?',
    )
    .get(row.record_id) as (FilingReference & { filed_as: string | null }) | null
  if (current?.filed_as) {
    throw new Error(
      `question ${row.number} is already filed as ${current.filed_as} at ${filingDisplay(current)}; ` +
        `inspect that filing rather than filing again`,
    )
  }
  throw new Error(`question ${row.number} changed before it was filed`)
}

export async function fileRuling(input: FileRulingInput, stores: RulingFileStores) {
  writableDb()
  const row = loadQuestion(input.questionId)
  const requested = requestedKind(input.as)
  if (requested === 'doc' && (input.scope ?? 'project') !== 'canon') filingScope(input.scope)
  const actor = sessionId()
  let authority: RootAuthority | null =
    row.run_record_id === null ? null : runMutationActor(row.run_record_id)
  const workflowActivity = Date.parse(row.workflow_updated_at ?? new Date().toISOString())
  const questionAuthority = authority ?? {
    runId: '',
    rootId: '',
    owner: row.workflow_owner,
    actor,
    ownerLastSeenAt: null,
    chainLastActivityAt: workflowActivity,
    coordinatorRun: false,
    now: Date.now(),
    windowMs: RUN_MUTATION_WINDOW_MS,
  }
  let adoptionReason: string | null = null
  if (row.run_record_id === null)
    adoptionReason = authorizeWorkflowQuestionMutation({
      owner: row.workflow_owner,
      actor,
      fromOperator: input.fromOperator,
      subject: `workflow cursor ${row.workflow_cursor_record_id}`,
      action: 'file',
      chainLastActivityAt: workflowActivity,
    })
  const decision = decideFiling(row, questionAuthority, input, requested)
  const denied = refusal(row, questionAuthority, decision)
  if (denied) throw new Error(denied)
  if (decision.kind === 'allow' && decision.operator && input.channel === 'ui' && authority)
    authority = { ...authority, actor: 'operator:ui' }
  const ruling = effectiveRuling({
    answer: row.answer,
    overturnedAt: row.overturned_at,
    replacement: row.replacement,
  })
  if (!ruling) {
    throw new Error(
      `question ${row.number} has no effective ruling to file; ` +
        `record its ruling first with ${questionRulingRemedy(row)}`,
    )
  }
  const at = nowIso()
  const body = renderRulingFileText({
    question: row.question,
    ruling,
    basis: row.replacement === null ? row.answer_basis : null,
    answererKind: answererKind(row),
    runId: row.run_record_id,
    runRecordId: row.run_record_id,
    workflow:
      row.workflow_cursor_record_id === null
        ? null
        : {
            slug: row.workflow_slug!,
            mode: row.mode_slug!,
            cursorId: row.workflow_cursor_number!,
          },
    taskKey: row.launch_key,
    date: at,
    questionId: row.number,
    questionRecordId: row.record_id,
  })
  const reference =
    requested === 'canon-proposal'
      ? await writeCanonProposal(row, body, stores)
      : await writeDocFiling(input, row, body, stores)
  writeTransaction(() => {
    if (row.run_record_id !== null) authority = adoptRunMutation(authority!, 'file')
    recordFiling(row, requested, reference, at)
    if (row.run_record_id !== null) auditRunMutation(authority!, 'file', `as ${requested}`)
    else
      auditQuestionMutation({
        questionId: row.record_id,
        action: 'file',
        actor,
        at,
        reason: `as ${requested}`,
        adoptionReason,
      })
    enqueueQuestionRecord(db(), row.record_id)
  })
  return filingResult(row, requested, reference, at)
}
