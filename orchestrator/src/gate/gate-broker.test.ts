import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { cloneRepository } from '../../../shared/test-git-repository.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { refreshGateBase, startGateBroker } from './gate-broker.ts'

async function waitForFinishedGate(id: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db().query('SELECT finished_at FROM gate_execution WHERE id=?').get(id) as {
      finished_at: string | null
    }
    if (row.finished_at) return
    await Bun.sleep(10)
  }
  throw new Error(`gate execution ${id} did not finish`)
}

function insertGateFixture(input: { worktree: string; gate: string }): {
  runId: string
  gateId: number
} {
  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        newRecordId(),
        `gate-broker-fixture-${newRecordId()}`,
        input.worktree,
        'bun',
        JSON.stringify({ gate: input.gate, trunk: 'main' }),
      ) as { id: string }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING record_id AS id`,
      )
      .get(
        new Date().toISOString(),
        'codex',
        'implement',
        projectId,
        'sha',
        input.worktree,
        'HEAD',
        'HEAD',
      ) as { id: string }
  ).id
  const gateId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_record_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
      )
      .get(runId, new Date().toISOString()) as { id: number }
  ).id
  return { runId, gateId }
}

test('base refresh resolves the branch remote and fetches without worker identity', () => {
  const calls: Array<{
    args: string[]
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
  }> = []
  const result = refreshGateBase(
    { mainCheckout: '/registered/main', landingBranch: 'develop' },
    (args, options) => {
      calls.push({ args, options })
      return {
        status: 0,
        stdout: Buffer.from(calls.length === 1 ? 'upstream\n' : ''),
        stderr: Buffer.from(''),
      }
    },
  )

  expect(calls.map((call) => call.args)).toEqual([
    ['config', '--get', 'branch.develop.remote'],
    ['fetch', '--no-tags', '--', 'upstream', 'develop'],
  ])
  expect(calls.every((call) => call.options.cwd === '/registered/main')).toBe(true)
  expect(calls.every((call) => call.options.timeout === 30_000)).toBe(true)
  expect(calls[1]!.options.env.ORCH_RUN_ID).toBeUndefined()
  expect(calls[1]!.options.env.ORCH_RUN_TOKEN).toBeUndefined()
  expect(result.message).toBe('gate base refresh passed: fetched upstream/develop')
})

test('base refresh does not guess a remote when the landing branch has none configured', () => {
  const calls: string[][] = []
  const result = refreshGateBase(
    { mainCheckout: '/registered/main', landingBranch: 'develop' },
    (args) => {
      calls.push(args)
      return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    },
  )

  expect(calls).toEqual([['config', '--get', 'branch.develop.remote']])
  expect(result.message).toBe('gate base refresh skipped: no configured remote for develop')
})

test('the broker records base refresh before running the gate', async () => {
  const worktree = cloneRepository(process.env, 'gate-broker-refresh-')
  const scratch = mkdtempSync(join(dir, 'gate-broker-refresh-scratch-'))
  const marker = join(scratch, 'gate-ran')
  const fixture = insertGateFixture({
    worktree,
    gate: `printf gate-ran > '${marker}'`,
  })
  const markerStatesDuringRefresh: boolean[] = []
  const broker = startGateBroker({
    runId: fixture.runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: worktree },
    refreshBase: (input) => {
      expect(input).toEqual({ mainCheckout: worktree, landingBranch: 'main' })
      markerStatesDuringRefresh.push(existsSync(marker))
      return { elapsedMs: 17, message: 'gate base refresh passed: fetched upstream/main' }
    },
    withHostSlot: async (run) => run(),
  })
  try {
    await waitForFinishedGate(fixture.gateId)
    const execution = db()
      .query(
        `SELECT exit_code,output_tail,base_refresh_elapsed_ms,base_refresh_result
         FROM gate_execution WHERE id=?`,
      )
      .get(fixture.gateId) as {
      exit_code: number
      output_tail: string
      base_refresh_elapsed_ms: number
      base_refresh_result: string
    }
    expect(markerStatesDuringRefresh).toEqual([false])
    expect(readFileSync(marker, 'utf8')).toBe('gate-ran')
    expect(execution.exit_code).toBe(0)
    expect(execution.base_refresh_elapsed_ms).toBe(17)
    expect(execution.base_refresh_result).toBe('gate base refresh passed: fetched upstream/main')
    expect(execution.output_tail).toContain(
      'gate base refresh passed: fetched upstream/main (17ms)',
    )
  } finally {
    await broker.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a failed base refresh is recorded and the gate still runs', async () => {
  const worktree = cloneRepository(process.env, 'gate-broker-refresh-failed-')
  const scratch = mkdtempSync(join(dir, 'gate-broker-refresh-failed-scratch-'))
  const marker = join(scratch, 'gate-ran')
  const fixture = insertGateFixture({ worktree, gate: `printf gate-ran > '${marker}'` })
  const broker = startGateBroker({
    runId: fixture.runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: worktree },
    refreshBase: () => ({
      elapsedMs: 23,
      message: 'gate base refresh failed for upstream/main: network unavailable',
    }),
    withHostSlot: async (run) => run(),
  })
  try {
    await waitForFinishedGate(fixture.gateId)
    const execution = db()
      .query(
        `SELECT exit_code,output_tail,base_refresh_elapsed_ms,base_refresh_result
         FROM gate_execution WHERE id=?`,
      )
      .get(fixture.gateId) as {
      exit_code: number
      output_tail: string
      base_refresh_elapsed_ms: number
      base_refresh_result: string
    }
    expect(readFileSync(marker, 'utf8')).toBe('gate-ran')
    expect(execution.exit_code).toBe(0)
    expect(execution.base_refresh_elapsed_ms).toBe(23)
    expect(execution.base_refresh_result).toBe(
      'gate base refresh failed for upstream/main: network unavailable',
    )
    expect(execution.output_tail).toContain(
      'gate base refresh failed for upstream/main: network unavailable (23ms)',
    )
  } finally {
    await broker.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an occupied gate log path fails the execution without following the path', async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-occupied-log-'))
  const scratch = join(root, 'scratch')
  const sentinel = join(root, 'sentinel.txt')
  mkdirSync(scratch)
  writeFileSync(sentinel, 'original')

  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        newRecordId(),
        'gate-broker-occupied-log-fixture',
        root,
        'bun',
        JSON.stringify({ gate: 'scripts/gate', trunk: 'main' }),
      ) as { id: string }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING record_id AS id`,
      )
      .get(
        new Date().toISOString(),
        'codex',
        'implement',
        projectId,
        'sha',
        root,
        'base',
        'head',
      ) as { id: string }
  ).id
  const gateId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_record_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING id`,
      )
      .get(runId, new Date().toISOString()) as { id: number }
  ).id
  const occupiedPath = join(scratch, `gate-${gateId}.log`)
  symlinkSync(sentinel, occupiedPath)

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { ORCH_MAIN_CHECKOUT: '/main/checkout' },
    withHostSlot: async (run) => run(),
  })
  try {
    await waitForFinishedGate(gateId)
    const execution = db()
      .query('SELECT exit_code,output_tail,output_artifact FROM gate_execution WHERE id=?')
      .get(gateId) as { exit_code: number; output_tail: string; output_artifact: string | null }

    expect(execution.exit_code).toBe(-1)
    expect(execution.output_artifact).toBeNull()
    expect(execution.output_tail).toContain(
      `gate log path is occupied: ${occupiedPath}; gate did not run`,
    )
    expect(readFileSync(sentinel, 'utf8')).toBe('original')
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
  }
})
