import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  claimSandboxHomeStep,
  readOnlyWorktreeStepRecorder,
  recordRunLeaseStep,
  recordRunWorktree,
} from './run-resource-step-recording.ts'

test('readOnlyWorktreeStepRecorder wires planned identity and shared ownership before creation', () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const planned = {
    path: '/tmp/DEV-2179-shared-reader',
    branch: '',
    base: 'fixture-base',
    repoRoot: '/tmp/fixture-repo',
    source: 'clone' as const,
    sharedReader: true,
  }
  const steps = readOnlyWorktreeStepRecorder(db(), {
    rootRunId: runId,
    runId,
    projectId: null,
    writesJob: false,
    claimedAt: () => '2026-11-07T00:00:00.000Z',
  })
  steps.recordPending!(planned)
  expect(
    db()
      .query(
        `SELECT state,allocation_key,identity,shared FROM resource_claim
         WHERE root_run_record_id=? AND kind='worktree'`,
      )
      .get(runId),
  ).toEqual({
    state: 'pending',
    allocation_key: planned.path,
    identity: JSON.stringify({ path: planned.path, head: planned.base, sharedReader: true }),
    shared: 1,
  })
  expect(steps.complete()).toBe(true)
  expect(
    db()
      .query(
        `SELECT state,step_no FROM resource_claim
         WHERE root_run_record_id=? AND kind='worktree'`,
      )
      .get(runId),
  ).toEqual({ state: 'claimed', step_no: 1 })

  const writer = readOnlyWorktreeStepRecorder(db(), {
    rootRunId: runId,
    runId,
    projectId: null,
    writesJob: true,
    claimedAt: () => '2026-11-07T00:00:00.000Z',
  })
  expect(writer.recordPending).toBeUndefined()
})

test('recordRunWorktree keeps a writing run on the legacy claim columns', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  recordRunWorktree(
    db(),
    {
      rootRunId: runId,
      runId,
      projectId: null,
      coverageBase: null,
      branch: 'DEV-2179-writing-fixture',
      steps: { complete: () => false },
    },
    {
      path: '/tmp/DEV-2179-writing-fixture',
      branch: 'DEV-2179-writing-fixture',
      base: 'fixture-base',
      repoRoot: '/tmp/fixture-repo',
      source: 'git',
    },
  )

  expect(
    db()
      .query(
        `SELECT kind,state,step_no,lifetime,shared FROM resource_claim
         WHERE root_run_record_id=? AND kind='worktree'`,
      )
      .get(runId),
  ).toEqual({ kind: 'worktree', state: 'claimed', step_no: null, lifetime: 'runtime', shared: 0 })
})

test('a read-only sandbox home is pending during preparation and claimed afterwards', async () => {
  const runId = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const root = mkdtempSync(join(tmpdir(), 'orch-sandbox-step-'))
  const home = join(root, 'home')
  try {
    await claimSandboxHomeStep(db(), {
      rootRunId: runId,
      runId,
      projectId: null,
      repoJob: true,
      writesJob: false,
      harness: 'codex',
      sandbox: 'host',
      path: home,
      claimedAt: new Date().toISOString(),
      effect: async () => {
        expect(
          db()
            .query(
              `SELECT state,allocation_key FROM resource_claim
               WHERE root_run_record_id=? AND kind='sandbox_dir'`,
            )
            .get(runId),
        ).toEqual({ state: 'pending', allocation_key: home })
        mkdirSync(home)
      },
    })
    expect(
      db()
        .query(
          `SELECT state,step_no FROM resource_claim
           WHERE root_run_record_id=? AND kind='sandbox_dir'`,
        )
        .get(runId),
    ).toEqual({ state: 'claimed', step_no: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an existing read-only sandbox home is still claimed idempotently', async () => {
  const runId = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const home = mkdtempSync(join(tmpdir(), 'orch-existing-sandbox-step-'))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await claimSandboxHomeStep(db(), {
        rootRunId: runId,
        runId,
        projectId: null,
        repoJob: true,
        writesJob: false,
        harness: 'codex',
        sandbox: 'host',
        path: home,
        claimedAt: new Date().toISOString(),
        effect: async () => undefined,
      })
    }
    expect(
      db()
        .query(
          `SELECT COUNT(*) count,
                  SUM(state='claimed') claimed_count,
                  SUM(state='absent') absent_count
           FROM resource_claim
           WHERE root_run_record_id=? AND kind='sandbox_dir'`,
        )
        .get(runId),
    ).toEqual({ count: 2, claimed_count: 1, absent_count: 1 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a read-only run lease is pending during acquire, claimed afterwards, and settled on release', () => {
  const runId = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const path = '/tmp/DEV-2179-run-lease.lock'
  let released = false
  const lease = recordRunLeaseStep(db(), {
    rootRunId: runId,
    runId,
    projectId: null,
    repoJob: true,
    writesJob: false,
    path,
    effect: () => {
      expect(
        db()
          .query(
            `SELECT state,allocation_key FROM resource_claim
             WHERE root_run_record_id=? AND kind='run_lease'`,
          )
          .get(runId),
      ).toEqual({ state: 'pending', allocation_key: path })
      return { release: () => (released = true) }
    },
  })
  expect(
    db()
      .query(
        "SELECT state,step_no FROM resource_claim WHERE kind='run_lease' AND root_run_record_id=?",
      )
      .get(runId),
  ).toEqual({ state: 'claimed', step_no: 1 })
  lease.release()
  expect(released).toBe(true)
  expect(
    db()
      .query("SELECT state FROM resource_claim WHERE kind='run_lease' AND root_run_record_id=?")
      .get(runId),
  ).toEqual({ state: 'released' })
})
