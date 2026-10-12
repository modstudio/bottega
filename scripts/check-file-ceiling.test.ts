import { describe, expect, test } from 'bun:test'
import { checkFileCeiling, fileLengthDecision, hasFormatSuppression } from './check-file-ceiling'

const facts = { renames: new Map(), addedLines: new Map() }

describe('file ceiling check', () => {
  test('recognizes format suppression comments without matching string contents', () => {
    expect(hasFormatSuppression('// biome-ignore format: keep this compact')).toBe(true)
    expect(hasFormatSuppression('  /* biome-ignore format: keep this compact */')).toBe(true)
    expect(hasFormatSuppression(`const example = '// biome-ignore format'`)).toBe(false)
    expect(hasFormatSuppression('const example = `/* biome-ignore format */`')).toBe(false)
  })

  test('a new over-limit file is refused', () => {
    expect(
      fileLengthDecision({ base: [], head: [{ path: 'new.ts', lines: 1001 }], facts }),
    ).toEqual([expect.objectContaining({ file: 'new.ts', measure: 1001, reason: 'new-measured' })])
  })

  test('an over-limit file that shrinks passes', () => {
    expect(
      fileLengthDecision({
        base: [{ path: 'large.ts', lines: 1200 }],
        head: [{ path: 'large.ts', lines: 1100 }],
        facts,
      }),
    ).toEqual([])
  })

  test('an over-limit file that grows is refused with its previous count', () => {
    expect(
      fileLengthDecision({
        base: [{ path: 'large.ts', lines: 1100 }],
        head: [{ path: 'large.ts', lines: 1200 }],
        facts,
      }),
    ).toEqual([
      expect.objectContaining({
        file: 'large.ts',
        measure: 1200,
        reason: 'grew',
        previousMeasure: 1100,
      }),
    ])
  })

  test('an over-limit file edited without growing passes', () => {
    expect(
      fileLengthDecision({
        base: [{ path: 'large.ts', lines: 1200 }],
        head: [{ path: 'large.ts', lines: 1200 }],
        facts,
      }),
    ).toEqual([])
  })

  test('refuses format suppression in measured source', () => {
    const errors: string[] = []

    const passed = checkFileCeiling({
      change: { base: [], head: [], facts },
      measureSuppressions: () => [{ path: 'squeezed.ts', lines: 10, ignoresFormat: true }],
      reporter: { error: (line) => errors.push(String(line)), log: () => undefined },
    })

    expect(passed).toBe(false)
    expect(errors).toEqual([
      'squeezed.ts: biome-ignore format is forbidden in measured source; split a concern out (canon 10-code: Respect the file ceiling)',
    ])
  })
})
