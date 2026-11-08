import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { prepareSandboxHomeStep, recordRunWorktree } from './run-resource-step-recording.ts'

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
    await prepareSandboxHomeStep(db(), {
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
      await prepareSandboxHomeStep(db(), {
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
          `SELECT COUNT(*) count,state FROM resource_claim
           WHERE root_run_record_id=? AND kind='sandbox_dir'`,
        )
        .get(runId),
    ).toEqual({ count: 1, state: 'claimed' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
