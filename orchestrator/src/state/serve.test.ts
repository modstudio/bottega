import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir, score } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { writeAskServerFailure } from '../ask/ask-failure.ts'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { recordReview } from '../review/review-triage.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { runDetail, state } from './serve.ts'

const RUN_DETAIL_ALIAS_REASON = 'The column is published under the stable run-detail field name.'
const RUN_DETAIL_DISPLAY_DEFERRED_REASON =
  'Whether this display candidate belongs in run show is deferred to a separate product decision.'
const RUN_DETAIL_LAUNCH_INTERNAL_REASON =
  'Launch, process, and transport internals are consumed by lifecycle services rather than run show.'
const RUN_DETAIL_ARTIFACT_ACCOUNTING_REASON =
  'Prompt and output accounting supports storage and diagnostics rather than run show.'
const RUN_DETAIL_PROVENANCE_REASON =
  'Provenance and evidence bookkeeping is presented through its derived reader-facing fields.'
const RUN_DETAIL_CLOSE_OUT_REASON =
  'Retention, teardown, and close-out bookkeeping is presented through lifecycle-specific surfaces.'
const RUN_DETAIL_USAGE_REASON =
  'Detailed usage and quota accounting is presented through cost and health surfaces.'
const RUN_DETAIL_ROUTING_REASON =
  'Routing and execution-policy metadata is presented through routing and review surfaces.'
const RUN_DETAIL_SECRET_REASON = 'Authentication material is never published by run show.'

const RUN_DETAIL_INTENTIONALLY_OMITTED_COLUMNS = {
  number: RUN_DETAIL_ALIAS_REASON,
  repo: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  prompt_sha: RUN_DETAIL_ARTIFACT_ACCOUNTING_REASON,
  prompt_bytes: RUN_DETAIL_ARTIFACT_ACCOUNTING_REASON,
  prompt_head: RUN_DETAIL_ARTIFACT_ACCOUNTING_REASON,
  label: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  lens: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  exit_code: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  output_bytes: RUN_DETAIL_ARTIFACT_ACCOUNTING_REASON,
  pid: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  session_id: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  retry_of_record_id: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  launch_cwd: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  launch_seed: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  launch_key: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  launch_base: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  no_failover: RUN_DETAIL_ROUTING_REASON,
  automatic_failover: RUN_DETAIL_ROUTING_REASON,
  route_reason: RUN_DETAIL_ROUTING_REASON,
  sandbox: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  branch: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  worktree: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  worktree_source: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  vendor_session: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  base_commit: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  carry_happened: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  carry_base_commit: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  carry_tracked_paths: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  carry_untracked_paths: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  parent_run_record_id: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  turn: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  files_changed: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  lines_added: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  lines_removed: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  deviations: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  escalations: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  stack: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  model: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  run_token: RUN_DETAIL_SECRET_REASON,
  outside_worktree_writes: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  agent_pid: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  mcp_trust_granted: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  mcp_trust_path: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  schema_path: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  docs_injected: RUN_DETAIL_PROVENANCE_REASON,
  transport: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  pre_confinement: RUN_DETAIL_PROVENANCE_REASON,
  spec_sha: RUN_DETAIL_PROVENANCE_REASON,
  keep_tree: RUN_DETAIL_CLOSE_OUT_REASON,
  project_record_id: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  last_event_at: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  minted_branch: RUN_DETAIL_CLOSE_OUT_REASON,
  unreconciled: RUN_DETAIL_CLOSE_OUT_REASON,
  mcp_probe: RUN_DETAIL_PROVENANCE_REASON,
  confinement: RUN_DETAIL_PROVENANCE_REASON,
  review_provenance: RUN_DETAIL_PROVENANCE_REASON,
  provenance_status: RUN_DETAIL_PROVENANCE_REASON,
  work_preserved: RUN_DETAIL_CLOSE_OUT_REASON,
  close_out_outcome: RUN_DETAIL_CLOSE_OUT_REASON,
  close_out_detail: RUN_DETAIL_CLOSE_OUT_REASON,
  close_out_attempted_at: RUN_DETAIL_CLOSE_OUT_REASON,
  agent_pgid: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  agent_start_time: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  keep_tree_until: RUN_DETAIL_CLOSE_OUT_REASON,
  keep_tree_reason: RUN_DETAIL_CLOSE_OUT_REASON,
  recipe_snapshot: RUN_DETAIL_CLOSE_OUT_REASON,
  started_by_user_id: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  task_record_id: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  gate_requests_closed: RUN_DETAIL_CLOSE_OUT_REASON,
  resource_teardown: RUN_DETAIL_CLOSE_OUT_REASON,
  agent_explicit: RUN_DETAIL_ROUTING_REASON,
  transport_explicit: RUN_DETAIL_ROUTING_REASON,
  vendor_input_tokens: RUN_DETAIL_USAGE_REASON,
  vendor_output_tokens: RUN_DETAIL_USAGE_REASON,
  host_wait_since: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  continuation_message_sha: RUN_DETAIL_PROVENANCE_REASON,
  review_role: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  selection_reason: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  executor: RUN_DETAIL_DISPLAY_DEFERRED_REASON,
  harness_wall_bound_ms: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  model_calls: RUN_DETAIL_USAGE_REASON,
  peak_call_tokens: RUN_DETAIL_USAGE_REASON,
  quota_used_percent_start: RUN_DETAIL_USAGE_REASON,
  quota_used_percent_end: RUN_DETAIL_USAGE_REASON,
  quota_window_minutes: RUN_DETAIL_USAGE_REASON,
  quota_resets_at: RUN_DETAIL_USAGE_REASON,
  endpoint_key_source: RUN_DETAIL_ROUTING_REASON,
  host_admission_first: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
  host_admission: RUN_DETAIL_LAUNCH_INTERNAL_REASON,
} as const satisfies Record<string, string>

const trackResidue = trackedTestResidue()
const runNumber = (recordId: string) =>
  db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
describe('probes are excluded from every query that reports', () => {
  test('byRepo leaves calibration traffic out', () => {
    // The rule is stated in AGENTS.md and this was the one aggregate that had
    // no test holding it: byRepo counted probes until it was noticed by eye.
    const real = addRun({ agent: 'grok', job: 'craft' })
    const probe = addRun({ agent: 'grok', job: 'craft', probe: 1 })
    for (const id of [real, probe]) {
      db().query("UPDATE run SET repo='devbox', vendor_tokens=100 WHERE record_id=?").run(id)
    }
    const rows = state(null).byRepo as { repo: string; runs: number; toks: number }[]
    const devbox = rows.find((r) => r.repo === 'devbox')!
    expect(devbox.runs).toBe(1)
    expect(devbox.toks).toBe(100)
  })
})

test('live child turns publish their chain root for hub badge matching', () => {
  const root = addRun({ agent: 'codex', job: 'craft', status: 'ok' })
  const child = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
    )
    .run(child, nowIso(), 'Which?')
  const live = state(null).live as { id: number; root_id: number }[]
  expect(live.find((row) => row.id === runNumber(child))).toMatchObject({
    id: runNumber(child),
    root_id: runNumber(root),
  })
})

describe('run detail', () => {
  test('accounts for every run column in the detail projection', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const detail = runDetail(id)!
    const columns = db().query<{ name: string }, []>('PRAGMA table_info(run)').all()
    const unexplained = columns
      .map((column) => column.name)
      .filter(
        (column) =>
          !Object.hasOwn(detail, column) &&
          !Object.hasOwn(RUN_DETAIL_INTENTIONALLY_OMITTED_COLUMNS, column),
      )
    expect(unexplained).toEqual([])
    const displayedButDeclaredOmitted = Object.keys(
      RUN_DETAIL_INTENTIONALLY_OMITTED_COLUMNS,
    ).filter((column) => Object.hasOwn(detail, column))
    expect(displayedButDeclaredOmitted).toEqual([])
  })

  test('returns a stored writer reply from before change guides', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const outputPath = trackResidue(join(dir, `old-writer-reply-${id}.txt`))
    const oldReply = JSON.stringify({
      status: 'done',
      summary: 'stored before change guides',
      files_changed: ['old.ts'],
      questions: null,
      deviations: null,
      blockers: null,
      tests: null,
    })
    writeFileSync(outputPath, oldReply)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(outputPath, id)
    expect(runDetail(id)?.output).toBe(oldReply)
  })

  test('publishes ask lifecycle evidence and distinguishes a missing log', () => {
    const missing = addRun({ agent: 'codex', job: 'implement' })
    expect(runDetail(missing)!.ask_server).toMatchObject({
      expected: 'not_recorded',
      started: 'not_recorded',
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    appendRunEvent(id, {
      ts: 't1',
      type: 'ask_expected',
      transport: 'srt',
      command: ['orch', 'ask-proxy'],
    })
    expect(runDetail(id)!.ask_server).toMatchObject({
      expected: 'seen',
      started: 'not_seen',
      transport: 'srt',
      command: ['orch', 'ask-proxy'],
    })
  })

  test('reads an ask startup failure while live and after scratch is persisted', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    mkdirSync(runScratchDir(live), { recursive: true })
    writeAskServerFailure(new Error('live startup failed'), runScratchDir(live))
    expect(runDetail(live)!.ask_server).toMatchObject({ failure: 'live startup failed' })

    const finished = addRun({ agent: 'codex', job: 'implement' })
    mkdirSync(runArtifactsDir(finished), { recursive: true })
    writeAskServerFailure(new Error('persisted startup failed'), runArtifactsDir(finished))
    expect(runDetail(finished)!.ask_server).toMatchObject({ failure: 'persisted startup failed' })
  })

  test('publishes overturned questions with their reason', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db()
      .query(
        `INSERT INTO question
          (number,record_id,run_record_id,asked_at,question,answer,answered_at,overturned_at,overturned_by,overturn_reason)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-20','Which?','Old','2026-09-21','2026-09-22','owner','Wrong evidence')`,
      )
      .run(id)
    expect(runDetail(id)!.questions).toEqual([
      expect.objectContaining({
        question: 'Which?',
        overturned_at: '2026-09-22',
        overturn_reason: 'Wrong evidence',
        ruling_status: 'overturned',
      }),
    ])
  })

  test('publishes a filed ruling identity', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db()
      .query(
        `INSERT INTO question
          (number,record_id,run_record_id,asked_at,question,answer,answered_at,filed_as,filed_record_id,filed_label,filed_at)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-20','Which?','Keep it.','2026-09-21','canon-proposal',
                 '11111111-1111-4111-8111-111111111111','${PLATFORM_SLUG}#44','2026-09-22')`,
      )
      .run(id)
    expect(runDetail(id)!.questions).toEqual([
      expect.objectContaining({
        question: 'Which?',
        filed_as: 'canon-proposal',
        filed_ref: null,
        filed_record_id: '11111111-1111-4111-8111-111111111111',
        filed_label: `${PLATFORM_SLUG}#44`,
        filed_at: '2026-09-22',
      }),
    ])
  })

  test('publishes local review lenses and findings in hosted detail shape', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET lens='correctness', model='gpt' WHERE record_id=?").run(id)
    recordReview(id, reviewReply(1), db())
    expect(runDetail(id)!.reviews).toMatchObject([
      {
        id: expect.any(String),
        reviewId: expect.any(String),
        runId: id,
        reviewNumber: expect.any(Number),
        lens: expect.any(String),
        agent: 'codex',
        standardsRead: expect.any(Array),
        filesCovered: expect.any(Array),
        findings: [
          {
            id: expect.any(String),
            reviewId: expect.any(String),
            reviewLensId: expect.any(String),
            ordinal: 1,
            severity: expect.any(String),
            proposedCorrection: expect.any(String),
          },
        ],
      },
    ])
  })

  test('publishes every field hub reads without publishing the ask credential', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed', latency: 1234, probe: 1 })
    const promptPath = trackResidue(join(dir, 'detail-prompt.txt'))
    const outputPath = trackResidue(join(dir, 'detail-output.txt'))
    writeFileSync(promptPath, 'the whole prompt')
    writeFileSync(outputPath, 'the whole reply')
    db()
      .query(
        `UPDATE run SET vendor_tokens=?, failure_kind=?, evidence_excluded=?, error=?,
                      prompt_path=?, output_path=?, run_token=?, doc_revisions=?, canon_sha=? WHERE record_id=?`,
      )
      .run(
        5678,
        'timeout',
        'not evidence',
        'timed out',
        promptPath,
        outputPath,
        'secret',
        '[4,9]',
        'canon-123',
        id,
      )
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_record_id=?').run('read by hub', id)
    const detail = runDetail(id)!
    expect(detail).toMatchObject({
      id: runNumber(id),
      record_id: id,
      requested_id: id,
      resolved_from: 'root',
      root_id: runNumber(id),
      agent: 'grok',
      job: 'craft',
      latency_ms: 1234,
      vendor_tokens: 5678,
      status: 'failed',
      failure_kind: 'timeout',
      probe: 1,
      evidence_excluded: 'not evidence',
      error: 'timed out',
      doc_revisions: '[4,9]',
      canon_sha: 'canon-123',
      delivery: 'partial',
      quality: 'mixed',
      note: 'read by hub',
      prompt: 'the whole prompt',
      output: 'the whole reply',
    })
    expect(detail).not.toHaveProperty('run_token')
  })
  test('publishes ordered chain audit and renders a missing actor explicitly', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET parent_run_record_id=?, turn=2 WHERE record_id=?').run(root, child)
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (record_id, run_record_id, root_run_record_id, action, actor_session, at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insertAudit.run(newRecordId(), root, root, 'stop', null, '2026-09-05T01:00:00.000Z', null)
    insertAudit.run(
      newRecordId(),
      child,
      root,
      'continue',
      'architect-session',
      '2026-09-05T02:00:00.000Z',
      'ruled',
    )
    expect(runDetail(child)!.audit).toMatchObject([
      {
        run_record_id: root,
        root_id: runNumber(root),
        action: 'stop',
        actor_session: 'anonymous (no session id)',
        at: '2026-09-05T01:00:00.000Z',
        reason: null,
      },
      {
        run_record_id: child,
        root_id: runNumber(root),
        action: 'continue',
        actor_session: 'architect-session',
        at: '2026-09-05T02:00:00.000Z',
        reason: 'ruled',
      },
    ])
    expect(runDetail(child)).toMatchObject({
      id: runNumber(child),
      record_id: child,
      requested_id: child,
      resolved_from: 'turn',
      root_id: runNumber(root),
    })
    expect(() =>
      insertAudit.run(newRecordId(), root, root, 'invented', null, nowIso(), null),
    ).toThrow()
  })
})
