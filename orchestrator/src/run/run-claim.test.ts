import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import {
  assertMigrationDispatchAllowed,
  clearMigrationDrain,
  recordMigrationDispatchRefusal,
  setMigrationDrain,
} from '../database/migration-drain.ts'
import { upsertProject } from '../project/projects.ts'
import { claimRun } from './run-claim.ts'
import { harnessAgent } from './run-harness-launch.ts'
import { RUN_REFERENCE_REFUSAL } from './run-task-reference.ts'

test('a later claim records a UUID ruling identity and never resurrects a failed reservation', async () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const reserved = addRun({ agent: '(pending)', job: 'review-lens', status: 'running' })
  db().query("UPDATE run SET review_role='round' WHERE record_id=?").run(reserved)
  const reservedRecordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(reserved)!.record_id
  expect(reservedRecordId[14]).toBe('7')
  const carriedQuestionRecordId = (
    db()
      .query<{ record_id: string }, [string, string]>(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
         VALUES (1,?,?,'2026-10-14','Which?') RETURNING record_id`,
      )
      .get(newRecordId(), root) as { record_id: string }
  ).record_id
  const runsDir = mkdtempSync(join(tmpdir(), 'later-findings-claim-'))

  try {
    const claimInput: Parameters<typeof claimRun>[0] = {
      opts: {
        job: 'review-lens',
        reserveId: reserved,
        reviewRole: 'round',
        transport: 'cli',
        resume: {
          kind: 'continue',
          parent: root,
          agent: 'codex',
          turn: 2,
          sessionId: null,
          worktree: null,
        },
      },
      runsDir,
      stamp: 'later-findings-claim',
      name: 'codex',
      generatedSchema: null,
      originalPrompt: 'review the change',
      prompt: 'review the change',
      callerCwd: runsDir,
      seed: undefined,
      writesJob: false,
      repoJob: false,
      runProjectName: null,
      runProjectId: null,
      reason: 'test',
      vendorSession: null,
      pack: null,
      mcpRequest: undefined,
      transportName: 'cli',
      a: AGENTS.codex!,
      mcpConnection: null,
      mcpMode: null,
      declaredDeliverables: [],
      timeoutMinutes: undefined,
      timeoutMs: 60_000,
      forbidsRepo: true,
      reviewTarget: null,
      implicitReview: { branch: null, findings: true },
      coverageBase: null,
      readOnlyBase: null,
      deferredCwdMcpPlan: [],
      usingMcp: false,
      startedByUserId: null,
      replySchemaName: 'WORKER_SCHEMA',
      carriedQuestionIds: [carriedQuestionRecordId],
      assertDispatchAllowed: () => {},
    }
    await expect(
      claimRun({
        ...claimInput,
        opts: { job: 'review-lens' },
        stamp: 'unlinked-claim',
        carriedQuestionIds: [],
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)

    const projectRecordId = newRecordId()
    upsertProject({ recordId: projectRecordId, name: 'claim-fixture', path: runsDir })
    claimInput.runProjectName = 'claim-fixture'
    claimInput.runProjectId = projectRecordId
    const claimed = await claimRun(claimInput)

    expect(claimed.claim.id).toBe(reserved)
    expect(
      db().query('SELECT transport_explicit FROM run WHERE record_id=?').get(claimed.claim.id),
    ).toEqual({ transport_explicit: 1 })
    expect(
      db().query('SELECT review_role FROM run WHERE record_id=?').get(claimed.claim.id),
    ).toEqual({
      review_role: 'round',
    })
    expect(db().query('SELECT record_id FROM run WHERE record_id=?').get(claimed.claim.id)).toEqual(
      {
        record_id: reservedRecordId,
      },
    )
    expect(
      db()
        .query<{ record_id: string }, [string]>(
          'SELECT record_id FROM run_carried_ruling WHERE run_record_id=?',
        )
        .get(claimed.claim.id)?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    const implicit = await claimRun({
      ...claimInput,
      opts: { job: 'review-lens' },
      stamp: 'implicit-transport-claim',
      carriedQuestionIds: [],
    })
    expect(
      db().query('SELECT transport_explicit FROM run WHERE record_id=?').get(implicit.claim.id),
    ).toEqual({ transport_explicit: 0 })

    const harness = await claimRun({
      ...claimInput,
      opts: { job: 'review-lens' },
      stamp: 'harness-claim',
      name: 'harness',
      a: harnessAgent(),
      carriedQuestionIds: [],
    })
    expect(
      db()
        .query(
          'SELECT agent,executor,evidence_excluded,pid,agent_pid,harness_wall_bound_ms FROM run WHERE record_id=?',
        )
        .get(harness.claim.id),
    ).toEqual({
      agent: 'harness',
      executor: 'harness',
      evidence_excluded: null,
      pid: null,
      agent_pid: null,
      harness_wall_bound_ms: 60_000,
    })

    const refusedPrompt = 'migrating fresh claim'
    const refusalsBefore = db()
      .query<{ count: number }, []>(
        "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
      )
      .get()!.count
    setMigrationDrain(db(), '0155_rebuild', 'migrating', {
      pid: process.pid,
      startTime: null,
    })
    try {
      await expect(
        claimRun({
          ...claimInput,
          opts: { job: 'review-lens' },
          stamp: 'migrating-fresh-claim',
          prompt: refusedPrompt,
          originalPrompt: refusedPrompt,
          carriedQuestionIds: [],
          assertDispatchAllowed: () => assertMigrationDispatchAllowed(db(), false),
          recordDispatchRefusal: recordMigrationDispatchRefusal,
        }),
      ).rejects.toThrow(/while migrating/)
      expect(
        db().query('SELECT record_id FROM run WHERE prompt_head=?').get(refusedPrompt),
      ).toBeNull()
      expect(
        db()
          .query<{ count: number }, []>(
            "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
          )
          .get()!.count,
      ).toBe(refusalsBefore + 1)
    } finally {
      clearMigrationDrain(db())
    }

    const failedReservation = addRun({
      agent: '(pending)',
      job: 'review-lens',
      status: 'failed',
    })
    await expect(
      claimRun({
        ...claimInput,
        opts: { job: 'review-lens', reserveId: failedReservation },
        stamp: 'failed-reservation-claim',
        carriedQuestionIds: [],
      }),
    ).rejects.toThrow('is no longer claimable')
    expect(
      db().query('SELECT status, agent FROM run WHERE record_id=?').get(failedReservation),
    ).toEqual({ status: 'failed', agent: '(pending)' })

    const setupFailureRoot = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
    const setupFailureTurn = addRun({
      agent: '(pending)',
      job: 'review-lens',
      status: 'running',
      parent: setupFailureRoot,
      turn: 2,
    })
    await expect(
      claimRun({
        ...claimInput,
        opts: {
          job: 'review-lens',
          reserveId: setupFailureTurn,
          resume: {
            kind: 'continue',
            parent: setupFailureRoot,
            agent: 'codex',
            turn: 2,
            sessionId: null,
            worktree: null,
          },
        },
        stamp: 'post-claim-setup-failure',
        carriedQuestionIds: [],
        deferredCwdMcpPlan: ['ensure-main-stack'],
      }),
    ).rejects.toThrow('deferred MCP main-stack step ran before project preflight')
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(setupFailureTurn),
    ).toEqual({ status: 'failed', failure_kind: 'harness' })
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(setupFailureRoot),
    ).toEqual({ status: 'failed', failure_kind: 'harness' })
    expect(
      db()
        .query("SELECT count(*) AS count FROM outbox WHERE kind='run' AND row_id=?")
        .get(setupFailureTurn),
    ).toEqual({ count: 1 })
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})
