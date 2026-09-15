import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkCognitiveCeiling } from './check-cognitive-ceiling'

let fixture: string | undefined

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('cognitive ceiling check', () => {
  test('writes a tighter baseline and fails with instructions to commit it', async () => {
    fixture = mkdtempSync(join(tmpdir(), 'cognitive-ceiling-'))
    const stateFile = join(fixture, 'cognitive-ceiling.json')
    const frozen = [{ file: 'complex.ts', function: 'complex', line: 10, score: 20 }]
    writeFileSync(stateFile, `${JSON.stringify(frozen, null, 2)}\n`)
    const errors: string[] = []

    const passed = await checkCognitiveCeiling({
      measure: async () => [{ ...frozen[0]!, key: 'complex.ts\0complex', score: 18 }],
      reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
      stateFile,
    })

    expect(passed).toBe(false)
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual([
      { file: 'complex.ts', function: 'complex', key: 'complex.ts\0complex', line: 10, score: 18 },
    ])
    expect(errors).toEqual([
      'scripts/quality/cognitive-ceiling.json: complex.ts:10 complex tightened 20 -> 18',
      'baseline tightened; commit scripts/quality/cognitive-ceiling.json and re-run (architecture-rules 16)',
    ])
    expect(
      await checkCognitiveCeiling({
        measure: async () => [{ ...frozen[0]!, key: 'complex.ts\0complex', score: 18 }],
        reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
        stateFile,
      }),
    ).toBe(true)
    expect(errors).toHaveLength(2)
  })
})
