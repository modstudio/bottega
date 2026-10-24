import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CHECK_EXECUTION_FILE_ENV } from '../../../shared/check-execution.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { createCheckpointSchedule } from '../run/checkpoint-schedule.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import {
  GATE_BASE_REFRESH_TIMEOUT_MS,
  gateBrokerLaunchArgv,
  refreshGateBase,
  runGateAfterBaseRefresh,
  startGateBroker,
} from './gate-broker.ts'
import { cancelPendingGateExecution, requestGateExecution } from './gate-run.ts'

test('gate request cancellation changes only an unfinished execution', () => {
  const runId = (
    db()
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'fixture','running')
         RETURNING record_id AS id`,
      )
      .get(newRecordId(), new Date().toISOString()) as { id: string }
  ).id
  const pending = requestGateExecution(runId)
  expect(cancelPendingGateExecution(pending.recordId, 'coordinator cancelled')).toBe(true)
  expect(
    db()
      .query('SELECT exit_code,cancelled_reason FROM gate_execution WHERE record_id=?')
      .get(pending.recordId),
  ).toEqual({ exit_code: -1, cancelled_reason: 'coordinator cancelled' })

  const finished = requestGateExecution(runId)
  db()
    .query(
      'UPDATE gate_execution SET finished_at=?,exit_code=0,timed_out=0,elapsed_ms=1 WHERE record_id=?',
    )
    .run(new Date().toISOString(), finished.recordId)
  expect(cancelPendingGateExecution(finished.recordId, 'late cancellation')).toBe(false)
  expect(
    db()
      .query('SELECT exit_code,cancelled_reason FROM gate_execution WHERE record_id=?')
      .get(finished.recordId),
  ).toEqual({ exit_code: 0, cancelled_reason: null })
})

test('a writing ACP gate broker launches with the run writer profile unchanged', async () => {
  const writer: SandboxRuntimeConfig = {
    network: {
      allowedDomains: ['openrouter.ai', '127.0.0.1:43127', '127.0.0.1:5432'],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [],
      allowWithinDeny: [],
      allowWrite: ['/tree', '/scratch'],
      denyWrite: ['/tree/.git'],
    },
  }
  const profiles: SandboxRuntimeConfig[] = []
  expect(
    await gateBrokerLaunchArgv(
      { kind: 'srt', profile: writer },
      'bun run check',
      async (profile, bin, argv) => {
        profiles.push(profile)
        return ['srt', bin, ...argv]
      },
    ),
  ).toEqual(['srt', 'sh', '-c', 'bun run check'])
  expect(profiles).toEqual([writer])
  expect(profiles[0]!.network).toBe(writer.network)
})

async function waitForFinishedGate(recordId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db()
      .query('SELECT finished_at FROM gate_execution WHERE record_id=?')
      .get(recordId) as {
      finished_at: string | null
    }
    if (row.finished_at) return
    await Bun.sleep(10)
  }
  throw new Error(`gate execution ${id} did not finish`)
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('records machine-readable checks emitted by a worker gate against its execution', async () => {
  const root = mkdtempSync(join(dir, 'gate-broker-check-execution-'))
  const scratch = mkdtempSync(join(dir, 'gate-broker-check-execution-scratch-'))
  mkdirSync(join(root, 'scripts'))
  const gatePath = join(root, 'scripts', 'gate')
  writeFileSync(
    gatePath,
    `#!/bin/sh\ngit diff --cached --name-only "$BOTTEGA_GATE_BASE_COMMIT" | grep -Fx worker.txt >/dev/null || exit 9\nprintf '%s\\n' '{"check":"unit suite","category":"unit-tests","wallMs":1,"exitCode":0}' >> "$${CHECK_EXECUTION_FILE_ENV}"\n`,
  )
  chmodSync(gatePath, 0o755)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'fixture@example.com')
  git(root, 'config', 'user.name', 'Fixture')
  git(root, 'add', 'scripts/gate')
  git(root, 'commit', '-qm', 'fixture')
  const head = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'worker.txt'), 'worker change')

  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        newRecordId(),
        'gate-broker-check-execution-fixture',
        root,
        'bun',
        JSON.stringify({ gate: 'scripts/gate' }),
      ) as { id: string }
  ).id
  const runId = (
    db()
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,1,'fixture','running',?,?,?,'git') RETURNING record_id AS id`,
      )
      .get(new Date().toISOString(), 'codex', 'implement', projectId, 'sha', root, head, head) as {
      id: string
    }
  ).id
  const gateRecordId = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id,run_record_id,requested_at) VALUES ('${newRecordId()}',?,?) RETURNING record_id`,
      )
      .get(runId, new Date().toISOString()) as { record_id: string }
  ).record_id

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { BOTTEGA_MAIN_CHECKOUT: root },
    confinement: { kind: 'host' },
    withHostSlot: async (run) => run(),
  })
  try {
    await waitForFinishedGate(gateRecordId)
    expect(
      db()
        .query(
          `SELECT gate_execution_record_id,check_name,category,exit_code
           FROM check_execution WHERE gate_execution_record_id=?`,
        )
        .get(gateRecordId),
    ).toEqual({
      gate_execution_record_id: gateRecordId,
      check_name: 'unit suite',
      category: 'unit-tests',
      exit_code: 0,
    })
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

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
  expect(calls.every((call) => call.options.timeout === GATE_BASE_REFRESH_TIMEOUT_MS)).toBe(true)
  expect(calls[1]!.options.env.BOTTEGA_RUN_ID).toBeUndefined()
  expect(calls[1]!.options.env.BOTTEGA_RUN_TOKEN).toBeUndefined()
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

test('base refresh reports a git config read failure separately from an absent remote', () => {
  const spawnFailure = refreshGateBase(
    { mainCheckout: '/registered/main', landingBranch: 'develop' },
    () => ({
      status: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: new Error('spawn git ENOENT'),
    }),
  )
  const statusFailure = refreshGateBase(
    { mainCheckout: '/registered/main', landingBranch: 'develop' },
    () => ({
      status: 2,
      stdout: Buffer.from(''),
      stderr: Buffer.from('bad config'),
    }),
  )

  expect(spawnFailure.message).toBe(
    'gate base refresh skipped: could not read branch.develop.remote: spawn git ENOENT',
  )
  expect(statusFailure.message).toBe(
    'gate base refresh skipped: could not read branch.develop.remote: bad config',
  )
})

test('base refresh failure uses the shared failure message template', () => {
  let invocation = 0
  const result = refreshGateBase(
    { mainCheckout: '/registered/main', landingBranch: 'develop' },
    () => {
      invocation += 1
      return invocation === 1
        ? {
            status: 0,
            stdout: Buffer.from('upstream\n'),
            stderr: Buffer.from(''),
          }
        : {
            status: 128,
            stdout: Buffer.from(''),
            stderr: Buffer.from('network unavailable'),
          }
    },
  )

  expect(result.message).toBe('gate base refresh failed: upstream/develop: network unavailable')
})

test('base refresh runs after slot acquisition immediately before the gate', async () => {
  const events: string[] = []
  const recorded: Array<{ elapsedMs: number; message: string }> = []
  const withHostSlot = async (run: () => Promise<void>) => {
    events.push('slot acquired')
    await run()
  }

  await withHostSlot(() =>
    runGateAfterBaseRefresh({
      refreshInput: {
        mainCheckout: '/registered/main',
        landingBranch: 'develop',
      },
      refreshBase: () => {
        events.push('base refreshed')
        return {
          elapsedMs: 17,
          message: 'gate base refresh passed: fetched upstream/develop',
        }
      },
      recordRefresh: (refresh) => {
        events.push('refresh recorded')
        recorded.push(refresh)
      },
      runGate: async () => {
        events.push('gate ran')
      },
    }),
  )

  expect(events).toEqual(['slot acquired', 'base refreshed', 'refresh recorded', 'gate ran'])
  expect(recorded).toEqual([
    {
      elapsedMs: 17,
      message: 'gate base refresh passed: fetched upstream/develop',
    },
  ])
})

test('a thrown base refresh is recorded and the gate still runs', async () => {
  const events: string[] = []
  const recorded: Array<{ elapsedMs: number; message: string }> = []

  await runGateAfterBaseRefresh({
    refreshInput: {
      mainCheckout: '/registered/main',
      landingBranch: 'develop',
    },
    refreshBase: () => {
      throw new Error('network unavailable')
    },
    recordRefresh: (refresh) => recorded.push(refresh),
    runGate: async () => {
      events.push('gate ran')
    },
  })

  expect(events).toEqual(['gate ran'])
  expect(recorded).toHaveLength(1)
  expect(recorded[0]!.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(recorded[0]!.message).toBe('gate base refresh failed: Error: network unavailable')
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
  const gate = (
    db()
      .query(
        `INSERT INTO gate_execution (record_id, run_record_id,requested_at) VALUES ('${newRecordId()}', ?,?) RETURNING record_id`,
      )
      .get(runId, new Date().toISOString()) as { record_id: string }
  )
  const gateNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM gate_execution WHERE record_id=?')
    .get(gate.record_id)!.number
  const occupiedPath = join(scratch, `gate-${gateNumber}.log`)
  symlinkSync(sentinel, occupiedPath)
  const checkpoints: string[] = []
  const checkpointSchedule = createCheckpointSchedule((trigger) => checkpoints.push(trigger))

  const broker = startGateBroker({
    runId,
    scratchDir: scratch,
    environment: { BOTTEGA_MAIN_CHECKOUT: '/main/checkout' },
    confinement: { kind: 'host' },
    withHostSlot: async (run) => run(),
    onExecutionStart: () => {
      checkpointSchedule.executionStarted()
      checkpointSchedule.request('scheduled')
    },
    onExecutionFinish: () => checkpointSchedule.executionFinished(),
  })
  try {
    await waitForFinishedGate(gate.record_id)
    const execution = db()
      .query('SELECT exit_code,output_tail,output_artifact FROM gate_execution WHERE record_id=?')
      .get(gate.record_id) as {
      exit_code: number
      output_tail: string
      output_artifact: string | null
    }

    expect(execution.exit_code).toBe(-1)
    expect(execution.output_artifact).toBeNull()
    expect(execution.output_tail).toContain(
      `gate log path is occupied: ${occupiedPath}; gate did not run`,
    )
    expect(checkpoints).toEqual(['scheduled'])
    expect(readFileSync(sentinel, 'utf8')).toBe('original')
  } finally {
    await broker.close()
    rmSync(root, { recursive: true, force: true })
  }
})
