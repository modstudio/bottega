import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { writeFocusedTestFileAtomic } from './focused-test-files.ts'
import {
  FOCUSED_TEST_REQUEST_FILE,
  focusedTestProgressFile,
  focusedTestResultFile,
  requestFocusedTests,
} from './focused-test-request.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratchDirectory(): string {
  const scratchDir = mkdtempSync(join(tmpdir(), 'focused-request-'))
  roots.push(scratchDir)
  return scratchDir
}

function emittedRequest(scratchDir: string): {
  id: string
  paths: string[]
  affected: boolean
  expect?: 'fail'
} {
  return JSON.parse(readFileSync(join(scratchDir, FOCUSED_TEST_REQUEST_FILE), 'utf8')) as {
    id: string
    paths: string[]
    affected: boolean
    expect?: 'fail'
  }
}

function answerRequest(scratchDir: string, request: { id: string }): void {
  writeFocusedTestFileAtomic(
    join(scratchDir, focusedTestResultFile(request.id)),
    JSON.stringify({
      exitCode: 1,
      timedOut: false,
      elapsedMs: 42,
      logName: `focused-test-${request.id}.log`,
      outputTail: 'one failure',
    }),
  )
}

function expectedResult(runId: string, scratchDir: string, request: { id: string }): string {
  return [
    'Focused tests exited 1 in 42ms.',
    `Full log: ${join(scratchDir, `focused-test-${request.id}.log`)}`,
    `After the run closes: ${join(runArtifactsDir(runId), `focused-test-${request.id}.log`)}`,
    'Output tail:\none failure',
  ].join('\n')
}

function shortWait() {
  let now = 0
  return {
    waitMs: 1,
    now: () => now,
    wait: async (ms: number) => {
      now += ms
    },
  }
}

test('request handoff lets a simultaneous call join the same execution', async () => {
  const scratchDir = scratchDirectory()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const signal = new AbortController().signal
  const first = requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/one.test.ts'],
    signal,
  })
  const request = emittedRequest(scratchDir)
  expect(request.paths).toEqual(['tests/one.test.ts'])

  const joined = requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/two.test.ts'],
    signal,
  })
  answerRequest(scratchDir, request)

  expect(await first).toBe(expectedResult(runId, scratchDir, request))
  expect(await joined).toBe(
    `Focused tests for "tests/one.test.ts" were already running; ` +
      `this call ignored its requested paths ("tests/two.test.ts") and waited for the same execution.\n` +
      expectedResult(runId, scratchDir, request),
  )
})

test('a capped wait leaves the execution available for a later joining call', async () => {
  const scratchDir = scratchDirectory()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const signal = new AbortController().signal
  let now = 0
  const first = await requestFocusedTests(
    { runId, scratchDir, paths: ['tests/slow.test.ts'], signal },
    {
      waitMs: 1,
      now: () => now,
      wait: async () => {
        now += 1
        const request = emittedRequest(scratchDir)
        writeFocusedTestFileAtomic(
          join(scratchDir, focusedTestProgressFile(request.id)),
          'waiting 250ms for host capacity (held_on=load)',
        )
      },
    },
  )
  expect(first).toBe(
    'Focused tests for "tests/slow.test.ts" are still running. ' +
      'Call run_tests again to wait for and collect this same execution.\n' +
      'waiting 250ms for host capacity (held_on=load)',
  )

  const request = emittedRequest(scratchDir)
  const joined = requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/ignored.test.ts'],
    signal,
  })
  answerRequest(scratchDir, request)
  const result = await joined
  expect(result).toContain(
    'this call ignored its requested paths ("tests/ignored.test.ts") and waited for the same execution.',
  )
  expect(result).toContain(expectedResult(runId, scratchDir, request))
})

test('a finished uncollected result is returned before a new request starts', async () => {
  const scratchDir = scratchDirectory()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const signal = new AbortController().signal
  await requestFocusedTests(
    { runId, scratchDir, paths: ['tests/slow.test.ts'], signal },
    shortWait(),
  )
  const request = emittedRequest(scratchDir)
  answerRequest(scratchDir, request)

  const collected = await requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/new.test.ts'],
    signal,
  })
  expect(collected).toContain(
    'Focused tests for "tests/slow.test.ts" finished after an earlier run_tests call stopped waiting; returning that result.',
  )
  expect(collected).toContain(expectedResult(runId, scratchDir, request))
  expect(emittedRequest(scratchDir)).toEqual(request)
})

test('an affected request travels through the same scratch file as its paths', async () => {
  const scratchDir = scratchDirectory()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const signal = new AbortController().signal
  const pending = requestFocusedTests({
    runId,
    scratchDir,
    paths: [],
    affected: true,
    signal,
  })
  const request = emittedRequest(scratchDir)
  expect(request.affected).toBeTrue()
  expect(request.paths).toEqual([])
  answerRequest(scratchDir, request)
  expect(await pending).toBe(expectedResult(runId, scratchDir, request))
})

test('an expect-fail declaration belongs to the execution that starts', async () => {
  const scratchDir = scratchDirectory()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const signal = new AbortController().signal
  const first = requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/mutation.test.ts'],
    expect: 'fail',
    signal,
  })
  const request = emittedRequest(scratchDir)
  expect(request.expect).toBe('fail')

  const joined = requestFocusedTests({
    runId,
    scratchDir,
    paths: ['tests/ignored.test.ts'],
    signal,
  })
  answerRequest(scratchDir, request)
  await first
  expect(await joined).toContain("The running execution declares expect: 'fail'.")
  expect(emittedRequest(scratchDir).expect).toBe('fail')
})
