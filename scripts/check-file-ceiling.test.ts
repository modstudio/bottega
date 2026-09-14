import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkFileCeiling } from './check-file-ceiling'

let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('file ceiling check', () => {
  test('writes a tighter baseline and fails with instructions to commit it', () => {
    fixture = mkdtempSync(join(tmpdir(), 'file-ceiling-'))
    const stateFile = join(fixture, 'file-ceiling.json')
    writeFileSync(stateFile, `${JSON.stringify({ 'large.ts': 1200 }, null, 2)}\n`)
    const errors: string[] = []

    const passed = checkFileCeiling({
      exists: () => true,
      measure: () => [{ path: 'large.ts', lines: 1100 }],
      reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
      stateFile,
    })

    expect(passed).toBe(false)
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ 'large.ts': 1100 })
    expect(errors).toEqual([
      'scripts/quality/file-ceiling.json: large.ts tightened 1200 -> 1100',
      'baseline tightened; commit scripts/quality/file-ceiling.json and re-run (architecture-rules 15)',
    ])
    expect(checkFileCeiling({
      exists: () => true,
      measure: () => [{ path: 'large.ts', lines: 1100 }],
      reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
      stateFile,
    })).toBe(true)
    expect(errors).toHaveLength(2)
  })
})
