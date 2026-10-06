import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../database/migrations.ts'
import { GATE_OUTPUT_TAIL_BYTES } from './gate-decision.ts'
import { passingGateForCommit } from './gate-passed.ts'
import { architectGateProcessExitCode, runArchitectGate } from './gate-run.ts'

const repositoryPath = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

let priorDepth: string | undefined
let priorSession: string | undefined
const headCommit = 'a'.repeat(40)
const cleanGitState = () => ({ headCommit, porcelainPaths: [] })
beforeEach(() => {
  priorDepth = process.env.ORCH_DEPTH
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.ORCH_DEPTH
  process.env.CLAUDE_CODE_SESSION_ID = 'architect-session'
})
afterEach(() => {
  if (priorDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorDepth
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    repositoryPath,
    'bun',
    JSON.stringify({ gate: 'bun run check' }),
  )
  return d
}

test('maps recorded gate exit codes to process exit codes', () => {
  expect(architectGateProcessExitCode(0)).toBe(0)
  expect(architectGateProcessExitCode(7)).toBe(7)
  expect(architectGateProcessExitCode(-1)).toBe(1)
})

test('a gate that dirties the tree while it runs is not attributed to HEAD', async () => {
  const d = database()
  let ran = false
  await runArchitectGate({
    cwd: repositoryPath,
    d,
    gitState: () => ({ headCommit, porcelainPaths: ran ? [' M formatted.ts'] : [] }),
    write: () => {},
    runner: () => {
      ran = true
      return {
        exitCode: 0,
        output: '',
        startedAt: '2026-09-01T00:00:00.000Z',
        finishedAt: '2026-09-01T00:00:01.000Z',
        elapsedMs: 1000,
      }
    },
  })
  expect(d.query('SELECT head_commit FROM gate_execution').get()).toEqual({ head_commit: null })
})

test('inserts a finished dirty-tree gate without attributing it to HEAD', async () => {
  const d = database()
  const chunks: string[] = []
  const result = await runArchitectGate({
    cwd: repositoryPath,
    d,
    gitState: () => ({ headCommit, porcelainPaths: ['?? dirty.txt'] }),
    write: (chunk) => chunks.push(chunk),
    runner: ({ write }) => {
      write('ok\n')
      return {
        exitCode: 0,
        output: 'ok\n',
        startedAt: '2026-09-01T00:00:00.000Z',
        finishedAt: '2026-09-01T00:00:01.000Z',
        elapsedMs: 1000,
      }
    },
  })
  expect(result).toEqual({ id: 1, exitCode: 0 })
  expect(chunks).toEqual(['ok\n'])
  expect(
    d
      .query(
        `SELECT run_id,started_at,finished_at,exit_code,tooling_paths,head_commit,cwd,output_artifact
           FROM gate_execution`,
      )
      .get(),
  ).toEqual({
    run_id: null,
    started_at: '2026-09-01T00:00:00.000Z',
    finished_at: '2026-09-01T00:00:01.000Z',
    exit_code: 0,
    tooling_paths: '[]',
    head_commit: null,
    cwd: repositoryPath,
    output_artifact: null,
  })
  expect(passingGateForCommit(headCommit, repositoryPath, d).gateId).toBeNull()
})

test('bounds the recorded tail', async () => {
  const d = database()
  const output = 'x'.repeat(GATE_OUTPUT_TAIL_BYTES + 20)
  await runArchitectGate({
    cwd: repositoryPath,
    d,
    gitState: cleanGitState,
    write: () => {},
    runner: () => ({
      exitCode: 1,
      output,
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 1,
    }),
  })
  const tail = (d.query('SELECT output_tail FROM gate_execution').get() as { output_tail: string })
    .output_tail
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES)
})

test('withholds secret-shaped output', async () => {
  const d = database()
  await runArchitectGate({
    cwd: repositoryPath,
    d,
    gitState: cleanGitState,
    write: () => {},
    runner: () => ({
      exitCode: 0,
      output: 'token=ghp_exampletokenvalue',
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 1,
    }),
  })
  expect(
    (d.query('SELECT output_tail FROM gate_execution').get() as { output_tail: string })
      .output_tail,
  ).toBe('[withheld: secret-shaped content]')
})

test('refuses a project without a registered gate', async () => {
  const d = database()
  d.query("UPDATE project SET settings='{}'").run()
  expect(
    runArchitectGate({
      cwd: repositoryPath,
      d,
      runner: () => {
        throw new Error('should not run')
      },
    }),
  ).rejects.toThrow('has no registered gate')
})

test('refuses a worker session', async () => {
  process.env.ORCH_DEPTH = '1'
  expect(runArchitectGate({ cwd: repositoryPath, d: database() })).rejects.toThrow(
    'ORCH_DEPTH is set',
  )
})

test('refuses an unsupported harness without an architect identity', async () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.CODEX_THREAD_ID = 'unsupported-thread'
  expect(runArchitectGate({ cwd: repositoryPath, d: database() })).rejects.toThrow(
    'unsupported harness',
  )
})
