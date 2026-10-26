import { describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent, readEventLog, runEventsPath } from '../events.ts'
import {
  KEEP_RUN_FILES_DAYS,
  namedRunArtifactPaths,
  persistRunArtifacts,
  persistTerminalSnapshot,
  pruneRuns,
  RUNS_DIR,
  readDispatchState,
  reconcileRun,
  runArtifactsDir,
  runFilePaths,
  runScratchDir,
  terminalRunArtifactPaths,
  writeDispatchState,
} from './run-artifacts.ts'

const terminalSnapshot = () => ({
  status: 'ok',
  error: null,
  failureKind: null,
  output: 'complete',
  outputPath: '/tmp/output',
  promptPath: '/tmp/prompt',
  exitCode: 0,
  latencyMs: 123,
  vendorTokens: 34,
  modelCalls: 2,
  peakCallTokens: 20,
  vendorCostUsd: null,
  vendorInputTokens: 12,
  vendorOutputTokens: 22,
  vendorEstimatedCostUsd: 0.45,
  vendorCostSource: 'estimated',
  model: 'fixture-model',
  vendorSession: 'fixture-session',
  preConfinement: null,
  confinement: null,
  filesChanged: 1,
  changedPaths: '["file.ts"]',
  linesAdded: 2,
  linesRemoved: 1,
  testsRan: 1,
  testsPassed: 1,
  testsClaimDisagrees: 0,
  deviations: 0,
  escalations: 0,
})

const artifactPaths = (...paths: string[]) => paths.map((path) => ({ path, field: 'test.path' }))

test('terminal snapshot preserves every vendor usage field', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  persistTerminalSnapshot(id, terminalSnapshot())

  const stored = JSON.parse(readFileSync(join(RUNS_DIR, id, 'result.json'), 'utf8'))
  expect(stored).toMatchObject({
    vendorTokens: 34,
    modelCalls: 2,
    peakCallTokens: 20,
    vendorCostUsd: null,
    vendorInputTokens: 12,
    vendorOutputTokens: 22,
    vendorEstimatedCostUsd: 0.45,
    vendorCostSource: 'estimated',
  })
})

test('reconcile restores every vendor usage column from the terminal snapshot', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  db().query('UPDATE run SET unreconciled=1 WHERE record_id=?').run(id)
  persistTerminalSnapshot(id, terminalSnapshot())

  expect(reconcileRun(id)).toBe(`reconciled run ${id} as ok`)
  expect(
    db()
      .query(
        `SELECT vendor_tokens, model_calls, peak_call_tokens, vendor_cost_usd, vendor_input_tokens, vendor_output_tokens,
                vendor_estimated_cost_usd, vendor_cost_source
           FROM run WHERE record_id=?`,
      )
      .get(id),
  ).toEqual({
    vendor_tokens: 34,
    model_calls: 2,
    peak_call_tokens: 20,
    vendor_cost_usd: null,
    vendor_input_tokens: 12,
    vendor_output_tokens: 22,
    vendor_estimated_cost_usd: 0.45,
    vendor_cost_source: 'estimated',
  })
})

describe('run files are named by their run, not by the clock', () => {
  /**
   * Six review lenses fired concurrently put three runs inside one millisecond
   * with the same agent and job, so they shared a prompt file AND an output
   * file. Each worker read whichever prompt was written last, and all three
   * answered the same question while claiming to be three different lenses.
   * The session that hit it scored two of them `none` and caught it only
   * because the content did not match what it had asked for.
   *
   * The stored paths are the evidence, so the test reads them: two runs of the
   * same job started in the same millisecond must not name the same file.
   */
  test('neither call site names a run file from the clock alone', () => {
    // Asserted against the SOURCE, the way the stale-`blocked` guard is, because
    // reproducing a millisecond collision on demand is a race the test would
    // lose more often than the bug did.
    const dir = fileURLToPath(new URL('./', import.meta.url))
    for (const file of ['run-artifacts.ts']) {
      // Comments quote the OLD pattern on purpose, to record what went wrong.
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      for (const n of code.match(/`\$\{Date\.now\(\)\}[^`]*`/g) ?? []) {
        expect(n).toMatch(/reserveId|unique|randomUUID/)
      }
    }
  })

  test('two runs created in the same millisecond have distinct paths', () => {
    const clock = 1_700_000_000_000
    const first = runFilePaths(dir, clock, 1, 'codex', 'review-lens')
    const second = runFilePaths(dir, clock, 2, 'codex', 'review-lens')
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.output).not.toBe(second.output)
  })
})

describe('run file pruning', () => {
  test('deleting expired files nulls their matching database paths', () => {
    const files = join(dir, 'prune-files')
    try {
      mkdirSync(files)
      const prompt = join(files, 'old.prompt.txt')
      const output = join(files, 'old.txt')
      writeFileSync(prompt, 'prompt')
      writeFileSync(output, 'output')
      const old = new Date(Date.now() - (KEEP_RUN_FILES_DAYS + 1) * 86_400_000)
      utimesSync(prompt, old, old)
      utimesSync(output, old, old)
      const id = addRun({ agent: 'codex', job: 'file-question' })
      db()
        .query('UPDATE run SET prompt_path=?, output_path=? WHERE record_id=?')
        .run(prompt, output, id)

      pruneRuns(files)

      expect(existsSync(prompt)).toBe(false)
      expect(existsSync(output)).toBe(false)
      expect(
        db().query('SELECT prompt_path, output_path FROM run WHERE record_id=?').get(id),
      ).toEqual({
        prompt_path: null,
        output_path: null,
      })
    } finally {
      rmSync(files, { recursive: true, force: true })
    }
  })
})

test('artifacts are copied and listed', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-artifact-tree-'))
  mkdirSync(runScratchDir(id), { recursive: true })
  writeFileSync(join(runScratchDir(id), 'timing-table.txt'), 'file,ms\na,1\n')
  writeFileSync(join(tree, 'named-evidence.txt'), 'failing test\n')
  try {
    persistRunArtifacts(
      id,
      artifactPaths('named-evidence.txt'),
      { path: tree },
      {
        diff: 'fixture changed\n',
      },
    )
    expect(readFileSync(join(runArtifactsDir(id), 'timing-table.txt'), 'utf8')).toContain('a,1')
    expect(readFileSync(join(runArtifactsDir(id), 'named-evidence.txt'), 'utf8')).toContain(
      'failing test',
    )
    expect(readFileSync(join(runArtifactsDir(id), 'worktree.diff'), 'utf8')).toContain(
      'fixture changed',
    )
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
test('inline deliverable content does not request a file copy or fail persistence', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-inline-deliverable-tree-'))
  writeFileSync(join(tree, 'inline-answer.md'), 'this is a worktree file\n')
  try {
    const named = namedRunArtifactPaths(
      {
        files_written: null,
        deliverables: [{ name: 'answer.md', content: 'inline-answer.md' }],
      },
      [],
    )
    expect(() => persistRunArtifacts(id, named, { path: tree }, null)).not.toThrow()
    expect(existsSync(join(runArtifactsDir(id), 'inline-answer.md'))).toBe(false)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
test('terminal artifact loading names focused-test and gate logs from their structured fields', () => {
  const id = addRun({ agent: 'codex', job: 'implement' })
  const source = mkdtempSync(join(tmpdir(), 'orch-focused-log-'))
  const exact = join(source, 'focused-test-exact.log')
  const gate = join(source, 'gate-exact.log')
  const summaryOnly = join(source, 'focused-test-summary.log')
  writeFileSync(exact, 'exact log\n')
  writeFileSync(gate, 'gate log\n')
  writeFileSync(summaryOnly, 'summary log\n')
  try {
    appendRunEvent(id, {
      ts: '2026-10-21T12:00:00.000Z',
      type: 'focused_test',
      paths: ['test.ts'],
      started: true,
      exitCode: 0,
      timedOut: false,
      elapsedMs: 1,
      logName: 'focused-test-exact.log',
      logPath: exact,
    })
    appendRunEvent(id, {
      ts: '2026-10-21T12:00:01.000Z',
      type: 'gate_log',
      logPath: gate,
    })
    const named = terminalRunArtifactPaths(id, {
      files_written: null,
      deliverables: [
        {
          name: 'summary',
          content: `${summaryOnly}\nOutput: should not be parsed`,
        },
      ],
    })
    expect(named).toEqual([
      { path: exact, field: 'focused_test.logPath' },
      { path: gate, field: 'gate_log.logPath' },
    ])
    persistRunArtifacts(id, named, null, null)
    expect(readFileSync(join(runArtifactsDir(id), 'focused-test-exact.log'), 'utf8')).toBe(
      'exact log\n',
    )
    expect(readFileSync(join(runArtifactsDir(id), 'gate-exact.log'), 'utf8')).toBe('gate log\n')
    expect(existsSync(join(runArtifactsDir(id), 'focused-test-summary.log'))).toBe(false)
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})
test('an unreadable terminal event log yields no named event paths and persistence completes', () => {
  const id = addRun({ agent: 'codex', job: 'implement' })
  mkdirSync(runEventsPath(id), { recursive: true })
  const append = spyOn(fs, 'appendFileSync')

  try {
    const named = terminalRunArtifactPaths(id, null)

    expect(named).toEqual([])
    expect(() => persistRunArtifacts(id, named, null, null)).not.toThrow()
    expect(append).toHaveBeenCalledWith(
      runEventsPath(id),
      expect.stringContaining('named artifact logs may not have been retained'),
    )
  } finally {
    append.mockRestore()
  }
})
test('an absent terminal event log yields no named event paths without a warning', () => {
  const id = addRun({ agent: 'codex', job: 'implement' })

  expect(terminalRunArtifactPaths(id, null)).toEqual([])
  expect(existsSync(runEventsPath(id))).toBe(false)
})
test('malformed terminal event lines are skipped without discarding valid artifact paths', () => {
  const id = addRun({ agent: 'codex', job: 'implement' })
  const gate = join(tmpdir(), 'gate-before-truncated-event.log')
  appendRunEvent(id, {
    ts: '2026-10-21T12:00:00.000Z',
    type: 'gate_log',
    logPath: gate,
  })
  fs.appendFileSync(runEventsPath(id), '{"ts":"truncated"')

  const named = terminalRunArtifactPaths(id, null)

  expect(named).toEqual([{ path: gate, field: 'gate_log.logPath' }])
  expect(readEventLog(runEventsPath(id))).toContainEqual(
    expect.objectContaining({
      type: 'warning',
      text: expect.stringContaining(
        '1 malformed event log line was skipped; named artifact logs from it may not have been retained',
      ),
    }),
  )
})
test('artifacts written before scratch persistence survive the run 12430 files_written shape', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-artifact-evidence-tree-'))
  const evidence = join(runArtifactsDir(id), 'exp-evidence')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.md'), 'measurements\n')
  writeFileSync(join(evidence, 'poster.png'), 'pixels\n')
  mkdirSync(runScratchDir(id), { recursive: true })
  writeFileSync(join(runScratchDir(id), 'reply.json'), '{}\n')
  writeFileSync(join(tree, 'full-measurements.json'), '{}\n')
  try {
    expect(() =>
      persistRunArtifacts(
        id,
        artifactPaths('full-measurements.json', join(evidence, 'report.md'), evidence),
        { path: tree },
        null,
      ),
    ).not.toThrow()
    expect(readFileSync(join(evidence, 'report.md'), 'utf8')).toBe('measurements\n')
    expect(readFileSync(join(evidence, 'poster.png'), 'utf8')).toBe('pixels\n')
    expect(readFileSync(join(runArtifactsDir(id), 'reply.json'), 'utf8')).toBe('{}\n')
    expect(readFileSync(join(runArtifactsDir(id), 'full-measurements.json'), 'utf8')).toBe('{}\n')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
test('scratch entries replace collisions without removing other existing artifacts', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  mkdirSync(runArtifactsDir(id), { recursive: true })
  writeFileSync(join(runArtifactsDir(id), 'reply.json'), 'old\n')
  writeFileSync(join(runArtifactsDir(id), 'evidence.txt'), 'preserved\n')
  mkdirSync(runScratchDir(id), { recursive: true })
  writeFileSync(join(runScratchDir(id), 'reply.json'), 'new\n')

  persistRunArtifacts(id, null, null, null)

  expect(readFileSync(join(runArtifactsDir(id), 'reply.json'), 'utf8')).toBe('new\n')
  expect(readFileSync(join(runArtifactsDir(id), 'evidence.txt'), 'utf8')).toBe('preserved\n')
  expect(existsSync(runScratchDir(id))).toBe(false)
})
test('scratch directories merge recursively with existing artifact directories', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const evidence = join(runArtifactsDir(id), 'evidence')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'before.txt'), 'before\n')
  mkdirSync(join(runScratchDir(id), 'evidence'), { recursive: true })
  writeFileSync(join(runScratchDir(id), 'evidence', 'after.txt'), 'after\n')

  persistRunArtifacts(id, null, null, null)

  expect(readFileSync(join(evidence, 'before.txt'), 'utf8')).toBe('before\n')
  expect(readFileSync(join(evidence, 'after.txt'), 'utf8')).toBe('after\n')
  expect(existsSync(runScratchDir(id))).toBe(false)
})
test('a listed directory is copied recursively without following its symlinks', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const outside = mkdtempSync(join(tmpdir(), 'orch-artifact-directory-'))
  const evidence = join(outside, 'evidence')
  mkdirSync(evidence)
  writeFileSync(join(evidence, 'target.txt'), 'target\n')
  symlinkSync('target.txt', join(evidence, 'link.txt'))
  try {
    persistRunArtifacts(id, artifactPaths(evidence), null, null)
    const copied = join(runArtifactsDir(id), 'evidence')
    expect(readFileSync(join(copied, 'target.txt'), 'utf8')).toBe('target\n')
    expect(existsSync(join(copied, 'link.txt'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(runArtifactsDir(id), 'dropped.json'), 'utf8')),
    ).toContainEqual(
      expect.objectContaining({
        path: 'evidence/link.txt',
        reason: 'symlink',
        linkText: 'target.txt',
      }),
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
test('a listed symlink to a directory is recorded without following it', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const outside = mkdtempSync(join(tmpdir(), 'orch-linked-artifact-directory-'))
  const source = join(outside, 'source')
  const linked = join(outside, 'linked-evidence')
  mkdirSync(source)
  writeFileSync(join(source, 'result.txt'), 'durable\n')
  symlinkSync(source, linked)

  persistRunArtifacts(id, artifactPaths(linked), null, null)
  rmSync(outside, { recursive: true, force: true })

  expect(existsSync(join(runArtifactsDir(id), 'linked-evidence'))).toBe(false)
  expect(
    JSON.parse(readFileSync(join(runArtifactsDir(id), 'dropped.json'), 'utf8')),
  ).toContainEqual(
    expect.objectContaining({ path: 'linked-evidence', reason: 'symlink', linkText: source }),
  )
})
test('a scratch root replaced by a symlink is refused and its target is never copied', () => {
  const id = addRun({ agent: 'codex', job: 'understand' })
  const outside = mkdtempSync(join(tmpdir(), 'orch-linked-scratch-root-'))
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
  mkdirSync(join(runScratchDir(id), '..'), { recursive: true })
  symlinkSync(outside, runScratchDir(id))
  try {
    expect(() => persistRunArtifacts(id, null, null, null)).toThrow('symlinked root')
    expect(existsSync(join(runArtifactsDir(id), 'secret.txt'))).toBe(false)
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
  } finally {
    rmSync(runScratchDir(id), { force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
test('all named artifacts are checked before copy failures are reported together', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-multiple-artifact-failures-'))
  writeFileSync(join(tree, 'first-good.txt'), 'first\n')
  writeFileSync(join(tree, 'last-good.txt'), 'last\n')
  try {
    expect(() =>
      persistRunArtifacts(
        id,
        artifactPaths('first-good.txt', 'first-missing.txt', 'second-missing.txt', 'last-good.txt'),
        { path: tree },
        null,
      ),
    ).toThrow(/first-missing\.txt[\s\S]*second-missing\.txt/)
    expect(existsSync(join(runArtifactsDir(id), 'first-good.txt'))).toBe(false)
    expect(existsSync(join(runArtifactsDir(id), 'last-good.txt'))).toBe(false)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
test('a listed scratch or artifacts path that was never written is still a failure', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  mkdirSync(runScratchDir(id), { recursive: true })
  expect(() =>
    persistRunArtifacts(
      id,
      artifactPaths(
        join(runScratchDir(id), 'never-written.json'),
        join(runArtifactsDir(id), 'absent.md'),
      ),
      null,
      null,
    ),
  ).toThrow(/never-written\.json[\s\S]*absent\.md/)
})
test('a reclaimed lens tree leaves its artifacts', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-lens-tree-'))
  mkdirSync(runScratchDir(id), { recursive: true })
  writeFileSync(join(runScratchDir(id), 'lens-note.txt'), 'covered\n')
  persistRunArtifacts(id, null, { path: tree }, null)
  rmSync(tree, { recursive: true, force: true })
  expect(existsSync(runArtifactsDir(id))).toBe(true)
  expect(existsSync(join(runArtifactsDir(id), 'lens-note.txt'))).toBe(true)
})
test('an artifact copy failure records a harness failure and preserves the tree', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-failed-artifact-tree-'))
  try {
    expect(() =>
      persistRunArtifacts(id, artifactPaths('missing-evidence.txt'), { path: tree }, null),
    ).toThrow('could not copy named file missing-evidence.txt from test.path')
    expect(existsSync(tree)).toBe(true)
    expect(existsSync(runArtifactsDir(id))).toBe(false)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
test('an artifact persistence failure cannot overwrite a concurrent operator stop', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose', status: 'stopped' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-stopped-artifact-tree-'))
  try {
    expect(() => persistRunArtifacts(id, artifactPaths('missing'), { path: tree }, null)).toThrow()
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
      status: 'stopped',
    })
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('the adapter retains selected scratch files and records every dropped byte', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' })
  const scratch = runScratchDir(id)
  mkdirSync(join(scratch, 'repo', '.git'), { recursive: true })
  writeFileSync(join(scratch, 'repo', '.git', 'config'), 'git metadata')
  writeFileSync(join(scratch, 'repo', 'source.ts'), 'source')
  mkdirSync(join(scratch, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(scratch, 'nested', 'deep', 'named.txt'), 'named evidence')
  writeFileSync(join(scratch, 'nested', 'deep', 'unmentioned.txt'), 'drop me')
  writeFileSync(join(scratch, 'summary.txt'), 'summary')
  const resultPath = join(dirname(scratch), 'result.json')
  writeFileSync(resultPath, '{}')

  persistRunArtifacts(id, artifactPaths(join(scratch, 'nested', 'deep', 'named.txt')), null, {
    diff: 'diff --git a/a b/a\n',
  })

  expect(readFileSync(join(runArtifactsDir(id), 'summary.txt'), 'utf8')).toBe('summary')
  expect(readFileSync(join(runArtifactsDir(id), 'nested', 'deep', 'named.txt'), 'utf8')).toBe(
    'named evidence',
  )
  expect(existsSync(join(runArtifactsDir(id), 'repo'))).toBe(false)
  expect(existsSync(join(runArtifactsDir(id), 'nested', 'deep', 'unmentioned.txt'))).toBe(false)
  expect(JSON.parse(readFileSync(join(runArtifactsDir(id), 'dropped.json'), 'utf8'))).toEqual([
    { path: 'nested/deep/unmentioned.txt', size: 7, reason: 'outside retention depth' },
    { path: 'repo', size: 18, reason: 'copy', fileCount: 2 },
  ])
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({
    artifactBytesKept: 40,
    artifactBytesDropped: 25,
  })
})
test(`${PLATFORM_SLUG} run retry preserves a reader root deliverable contract and timeout`, () => {
  const root = addRun({ agent: 'codex', job: 'understand' })
  const child = addRun({ agent: 'grok', job: 'understand', parent: root, turn: 2 })
  writeDispatchState(root, { deliverables: ['x'], timeoutMinutes: 17 })
  writeDispatchState(child, readDispatchState(root))
  expect(readDispatchState(child)).toEqual({ deliverables: ['x'], timeoutMinutes: 17 })
})
