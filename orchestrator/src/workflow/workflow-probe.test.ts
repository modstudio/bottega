import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { recordWorkflowExec, recordWorkflowProbe } from './workflow-probe.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query(
    "INSERT INTO project (name,path,settings) VALUES ('probe-project','/tmp/probe','{}')",
  ).run()
  return d
}

test('records command, cwd, commit, exit and a bounded tail', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['printf', 'ok'], {
    cwd: '/tmp/probe',
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output: 'ok\n' }),
  })
  expect(result).toEqual({ id: 1, withheld: false })
  expect(
    d.query('SELECT command,cwd,head_commit,exit_code,output_tail,withheld FROM probe').get(),
  ).toEqual({
    command: '["printf","ok"]',
    cwd: '/tmp/probe',
    head_commit: 'abc',
    exit_code: 0,
    output_tail: 'ok\n',
    withheld: 0,
  })
})

test('withholds secret-shaped output', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['env'], {
    cwd: '/tmp/probe',
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output: 'token=ghp_exampletokenvalue' }),
  })
  expect(result.withheld).toBe(true)
  expect(
    (d.query('SELECT output_tail,withheld FROM probe').get() as { output_tail: string })
      .output_tail,
  ).toBe('[withheld: secret-shaped content]')
})

test('withholds secret-shaped command JSON', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['echo', 'token=ghp_exampletokenvalue'], {
    cwd: '/tmp/probe',
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output: 'ok' }),
  })
  expect(result.withheld).toBe(true)
  expect(d.query('SELECT command,output_tail FROM probe').get()).toEqual({
    command: '[withheld: secret-shaped content]',
    output_tail: '[withheld: secret-shaped content]',
  })
})

test('bounds a long tail using GATE_OUTPUT_TAIL_BYTES', async () => {
  const d = database()
  const output = 'x'.repeat(GATE_OUTPUT_TAIL_BYTES + 50)
  await recordWorkflowProbe(['yes'], {
    cwd: '/tmp/probe',
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output }),
  })
  const tail = (d.query('SELECT output_tail FROM probe').get() as { output_tail: string })
    .output_tail
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES)
})

test('refuses a missing command', async () => {
  expect(
    recordWorkflowProbe([], { d: database(), runner: () => ({ exitCode: 0, output: '' }) }),
  ).rejects.toThrow('orch workflow probe needs a command after --')
})

test('refuses a probe outside a registered project', async () => {
  expect(
    recordWorkflowProbe(['printf', 'ok'], {
      cwd: '/outside/project',
      d: database(),
      runner: () => ({ exitCode: 0, output: 'ok' }),
    }),
  ).rejects.toThrow('no registered project contains /outside/project')
})

test('exec records an architect command with its kind and session', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const d = database()
    const result = await recordWorkflowExec(['printf', 'ok'], {
      cwd: '/tmp/probe',
      d,
      commit: 'abc',
      runner: () => ({ exitCode: 0, output: 'ok\n' }),
    })
    expect(result).toEqual({ id: 1, withheld: false, exitCode: 0 })
    expect(d.query('SELECT kind,session_id,exit_code FROM probe').get()).toEqual({
      kind: 'exec',
      session_id: 'architect-session',
      exit_code: 0,
    })
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('exec refuses worker depth and missing architect identity', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.ORCH_DEPTH = '1'
    await expect(recordWorkflowExec(['true'], { d: database() })).rejects.toThrow(
      'ORCH_DEPTH is set',
    )
    delete process.env.ORCH_DEPTH
    delete process.env.CLAUDE_CODE_SESSION_ID
    await expect(recordWorkflowExec(['true'], { d: database() })).rejects.toThrow(
      'CLAUDE_CODE_SESSION_ID is not set',
    )
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('exec refuses a checkout outside a registered project', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    await expect(
      recordWorkflowExec(['true'], {
        cwd: '/outside/project',
        d: database(),
        registeredProject: false,
      }),
    ).rejects.toThrow('no registered project contains /outside/project')
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
