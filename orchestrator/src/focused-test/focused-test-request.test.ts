import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { writeFocusedTestFileAtomic } from './focused-test-files.ts'
import {
  FOCUSED_TEST_LOCK_FILE,
  FOCUSED_TEST_REQUEST_FILE,
  focusedTestResultFile,
  requestFocusedTests,
} from './focused-test-request.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('request handoff returns evidence and the real lock refuses a simultaneous call', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'focused-request-'))
  roots.push(scratchDir)
  const signal = new AbortController().signal
  const first = requestFocusedTests({
    runId: 123,
    scratchDir,
    paths: ['tests/one.test.ts'],
    signal,
  })
  const request = JSON.parse(readFileSync(join(scratchDir, FOCUSED_TEST_REQUEST_FILE), 'utf8')) as {
    id: string
    paths: string[]
  }
  expect(request.paths).toEqual(['tests/one.test.ts'])

  const concurrent = await requestFocusedTests({
    runId: 123,
    scratchDir,
    paths: ['tests/two.test.ts'],
    signal,
  })
  expect(concurrent).toBe('A focused test run is already in flight for this run.')

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
  rmSync(join(scratchDir, FOCUSED_TEST_REQUEST_FILE))
  rmSync(join(scratchDir, FOCUSED_TEST_LOCK_FILE))
  expect(await first).toBe(
    [
      'Focused tests exited 1 in 42ms.',
      `Full log: ${join(scratchDir, `focused-test-${request.id}.log`)}`,
      `After the run closes: ${join(runArtifactsDir(123), `focused-test-${request.id}.log`)}`,
      'Output tail:\none failure',
    ].join('\n'),
  )
})
