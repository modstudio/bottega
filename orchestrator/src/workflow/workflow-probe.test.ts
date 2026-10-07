import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../database/migrations.ts'
import { GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { recordWorkflowExec, recordWorkflowProbe } from './workflow-probe.ts'

const probeRepository = mkdtempSync(join(tmpdir(), 'workflow-probe-project-'))
const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
  cwd: probeRepository,
  stdout: 'pipe',
  stderr: 'pipe',
})
if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
afterAll(() => rmSync(probeRepository, { recursive: true, force: true }))

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query("INSERT INTO project (name,path,settings) VALUES ('probe-project',?,'{}')").run(
    probeRepository,
  )
  return d
}

test('records command, cwd, commit, exit and a bounded tail', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['printf', 'ok'], {
    cwd: probeRepository,
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output: 'ok\n' }),
  })
  expect(result).toEqual({
    id: 1,
    withheld: false,
    exitCode: 0,
    signal: null,
    outputTail: 'ok\n',
  })
  expect(
    d.query('SELECT command,cwd,head_commit,exit_code,output_tail,withheld FROM probe').get(),
  ).toEqual({
    command: '["printf","ok"]',
    cwd: probeRepository,
    head_commit: 'abc',
    exit_code: 0,
    output_tail: 'ok\n',
    withheld: 0,
  })
})

test('records the selected cwd and its head commit', async () => {
  const d = database()
  const cwd = process.cwd()
  d.query("INSERT INTO project (name,path,settings) VALUES ('cwd-project',?,'{}')").run(cwd)
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe' })
    .stdout.toString()
    .trim()

  await recordWorkflowProbe(['true'], {
    cwd,
    d,
    runner: () => ({ exitCode: 0, output: '' }),
  })

  expect(d.query('SELECT cwd,head_commit FROM probe').get()).toEqual({ cwd, head_commit: head })
})

test('withholds secret-shaped output', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['env'], {
    cwd: probeRepository,
    d,
    commit: 'abc',
    runner: () => ({ exitCode: 0, output: 'token=ghp_exampletokenvalue' }),
  })
  expect(result.withheld).toBe(true)
  expect(result.outputTail).toBe('[withheld: secret-shaped content]')
  expect(
    (d.query('SELECT output_tail,withheld FROM probe').get() as { output_tail: string })
      .output_tail,
  ).toBe('[withheld: secret-shaped content]')
})

test('withholds secret-shaped command JSON', async () => {
  const d = database()
  const result = await recordWorkflowProbe(['echo', 'token=ghp_exampletokenvalue'], {
    cwd: probeRepository,
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
    cwd: probeRepository,
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
      cwd: probeRepository,
      d,
      commit: 'abc',
      runner: () => ({ exitCode: 0, output: 'ok\n' }),
    })
    expect(result).toEqual({
      id: 1,
      withheld: false,
      exitCode: 0,
      signal: null,
      outputTail: 'ok\n',
    })
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

test('exec streams only a bounded output tail', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const d = database()
    await recordWorkflowExec(['/bin/sh', '-c', '/usr/bin/yes z | /usr/bin/head -c 20000'], {
      cwd: process.cwd(),
      d,
      commit: 'abc',
      write: () => {},
    })
    const tail = (d.query('SELECT output_tail FROM probe').get() as { output_tail: string })
      .output_tail
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES)
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('exec detects a chunk-split secret after it rolls out of the retained tail', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const d = database()
    const command = [
      '/bin/sh',
      '-c',
      "printf '\\x67\\x68'; /bin/sleep 0.02; printf '\\x70\\x5fexampletokenvalue'; /usr/bin/yes z | /usr/bin/head -c 20000",
    ]
    const result = await recordWorkflowExec(command, {
      cwd: process.cwd(),
      d,
      commit: 'abc',
      write: () => {},
    })
    expect(result.withheld).toBe(true)
    expect(
      (d.query('SELECT output_tail FROM probe').get() as { output_tail: string }).output_tail,
    ).toBe('[withheld: secret-shaped content]')
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('exec refuses worker depth and an unsupported harness identity', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorThread = process.env.CODEX_THREAD_ID
  try {
    process.env.ORCH_DEPTH = '1'
    await expect(recordWorkflowExec(['true'], { d: database() })).rejects.toThrow(
      'ORCH_DEPTH is set',
    )
    delete process.env.ORCH_DEPTH
    delete process.env.CLAUDE_CODE_SESSION_ID
    process.env.CODEX_THREAD_ID = 'unsupported-thread'
    await expect(recordWorkflowExec(['true'], { d: database() })).rejects.toThrow(
      'unsupported harness',
    )
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorThread === undefined) delete process.env.CODEX_THREAD_ID
    else process.env.CODEX_THREAD_ID = priorThread
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

test('exec reports a command that could not start without recording a row', async () => {
  const priorDepth = process.env.ORCH_DEPTH
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    delete process.env.ORCH_DEPTH
    process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
    const d = database()

    await expect(
      recordWorkflowExec(['/command/that/does/not/exist'], {
        cwd: probeRepository,
        d,
        commit: 'abc',
        write: () => {},
      }),
    ).rejects.toThrow('command could not be started:')

    expect(d.query('SELECT count(*) AS n FROM probe').get()).toEqual({ n: 0 })
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
