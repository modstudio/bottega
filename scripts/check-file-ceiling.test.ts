import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFileCeiling, hasFormatSuppression } from './check-file-ceiling'

let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('file ceiling check', () => {
  test('recognizes format suppression comments without matching string contents', () => {
    expect(hasFormatSuppression('// biome-ignore format: keep this compact')).toBe(true)
    expect(hasFormatSuppression('  /* biome-ignore format: keep this compact */')).toBe(true)
    expect(hasFormatSuppression(`const example = '// biome-ignore format'`)).toBe(false)
    expect(hasFormatSuppression('const example = `/* biome-ignore format */`')).toBe(false)
  })

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
      'baseline tightened; commit scripts/quality/file-ceiling.json and re-run (canon 10-code: Respect the file ceiling)',
    ])
    expect(
      checkFileCeiling({
        exists: () => true,
        measure: () => [{ path: 'large.ts', lines: 1100 }],
        reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
        stateFile,
      }),
    ).toBe(true)
    expect(errors).toHaveLength(2)
  })

  test('refuses format suppression in measured source', () => {
    fixture = mkdtempSync(join(tmpdir(), 'file-ceiling-'))
    const stateFile = join(fixture, 'file-ceiling.json')
    writeFileSync(stateFile, '{}\n')
    const errors: string[] = []

    const passed = checkFileCeiling({
      exists: () => true,
      measure: () => [{ path: 'squeezed.ts', lines: 10, ignoresFormat: true }],
      reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
      stateFile,
    })

    expect(passed).toBe(false)
    expect(errors).toEqual([
      'squeezed.ts: biome-ignore format is forbidden in measured source; split a concern out (canon 10-code: Respect the file ceiling)',
    ])
  })
})
