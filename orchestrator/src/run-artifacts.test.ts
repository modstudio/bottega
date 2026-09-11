import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KEEP_RUN_FILES_DAYS, addRun, db, dir, pruneRuns, runFilePaths,
} from '../test/fixture.ts'

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
    const dir = new URL('.', import.meta.url).pathname
    for (const file of ['run-artifacts.ts', 'cli.ts']) {
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
    mkdirSync(files)
    const prompt = join(files, 'old.prompt.txt')
    const output = join(files, 'old.txt')
    writeFileSync(prompt, 'prompt')
    writeFileSync(output, 'output')
    const old = new Date(Date.now() - (KEEP_RUN_FILES_DAYS + 1) * 86_400_000)
    utimesSync(prompt, old, old)
    utimesSync(output, old, old)
    const id = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET prompt_path=?, output_path=? WHERE id=?').run(prompt, output, id)

    pruneRuns(files)

    expect(existsSync(prompt)).toBe(false)
    expect(existsSync(output)).toBe(false)
    expect(db().query('SELECT prompt_path, output_path FROM run WHERE id=?').get(id))
      .toEqual({ prompt_path: null, output_path: null })
  })
})
