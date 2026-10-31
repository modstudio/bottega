import { describe, expect, test } from 'bun:test'
import {
  type ChangeFacts,
  type Finding,
  findingLine,
  introducedFindings,
  ratchetDecision,
} from './ratchet'

const finding = (line: number, message = 'test reaches 0 expect() calls'): Finding => ({
  file: 'example.test.ts',
  line,
  rule: 'test-reaches-expect',
  message,
})

test('a finding at line zero omits the nonexistent line number', () => {
  expect(findingLine(finding(0))).toBe(
    'example.test.ts test-reaches-expect test reaches 0 expect() calls',
  )
})

describe('quality finding ratchet', () => {
  test('a finding present at base and head is not reported', () => {
    expect(introducedFindings([finding(4)], [finding(4)])).toEqual([])
  })

  test('a finding only at head is reported with its location', () => {
    expect(introducedFindings([], [finding(9)])).toEqual([finding(9)])
  })

  test('a finding which moved lines is not reported', () => {
    expect(introducedFindings([finding(4)], [finding(40)])).toEqual([])
  })

  test('a decreased count in the message is not reported', () => {
    expect(
      introducedFindings(
        [finding(4, 'function has 12 branches')],
        [finding(4, 'function has 9 branches')],
      ),
    ).toEqual([])
  })
})

const change = (input: Partial<ChangeFacts> = {}): ChangeFacts => ({
  renames: input.renames ?? new Map(),
  addedLines: input.addedLines ?? new Map(),
})

const measured = (measure: number, symbol?: string): Finding => ({
  file: 'source.ts',
  line: 10,
  rule: 'function-size',
  message: `function has ${measure} lines`,
  measure,
  ...(symbol ? { symbol } : {}),
})

describe('ratchet decision', () => {
  test('a file with ten old findings edited elsewhere refuses nothing', () => {
    const findings = Array.from({ length: 10 }, (_, index) => finding(index + 1))
    expect(ratchetDecision({ base: findings, head: findings, change: change() })).toEqual([])
  })

  test('an old finding moved down by inserted lines refuses nothing', () => {
    expect(
      ratchetDecision({
        base: [finding(4)],
        head: [finding(40)],
        change: change({ addedLines: new Map([['example.test.ts', [{ start: 5, end: 39 }]]]) }),
      }),
    ).toEqual([])
  })

  test('an over-limit function made shorter pairs by symbol and refuses nothing', () => {
    expect(
      ratchetDecision({
        base: [measured(80, 'largeFunction')],
        head: [measured(60, 'largeFunction')],
        change: change(),
      }),
    ).toEqual([])
  })

  test('an over-limit function made shorter without symbols pairs by measure order', () => {
    expect(
      ratchetDecision({ base: [measured(80)], head: [measured(60)], change: change() }),
    ).toEqual([])
  })

  test('an over-limit function made longer is refused with its previous measure', () => {
    expect(
      ratchetDecision({
        base: [measured(60, 'largeFunction')],
        head: [measured(80, 'largeFunction')],
        change: change(),
      }),
    ).toEqual([{ ...measured(80, 'largeFunction'), reason: 'grew', previousMeasure: 60 }])
  })

  test('a new over-limit function is refused without refusing the existing function', () => {
    const existing = measured(60, 'existingFunction')
    const added = { ...measured(55, 'newFunction'), line: 90 }
    expect(
      ratchetDecision({
        base: [existing],
        head: [existing, added],
        change: change(),
      }),
    ).toEqual([{ ...added, reason: 'new-measured' }])
  })

  test('one finding fixed and an identical one added on an added line is refused', () => {
    const added = finding(20)
    expect(
      ratchetDecision({
        base: [finding(4)],
        head: [added],
        change: change({ addedLines: new Map([['example.test.ts', [{ start: 20, end: 20 }]]]) }),
      }),
    ).toEqual([{ ...added, reason: 'added-line' }])
  })

  test('one finding fixed and a different-message finding added on an unchanged line is refused', () => {
    const added = finding(20, 'test uses a trivial assertion')
    expect(ratchetDecision({ base: [finding(4)], head: [added], change: change() })).toEqual([
      { ...added, reason: 'count' },
    ])
  })

  test('a renamed file keeps its old findings and refuses one extra finding', () => {
    const oldFinding = { ...finding(4), file: 'old.test.ts' }
    const renamedFinding = { ...finding(4), file: 'new.test.ts' }
    const extraFinding = { ...finding(20), file: 'new.test.ts', message: 'another finding' }
    const rename = change({ renames: new Map([['new.test.ts', 'old.test.ts']]) })
    expect(ratchetDecision({ base: [oldFinding], head: [renamedFinding], change: rename })).toEqual(
      [],
    )
    expect(
      ratchetDecision({ base: [oldFinding], head: [renamedFinding, extraFinding], change: rename }),
    ).toEqual([{ ...extraFinding, reason: 'count' }])
  })

  test.each(['old.test.ts', 'new.test.ts'])(
    'a renamed file keeps its allowance when the base report names %s',
    (basePath) => {
      const baseFinding = { ...finding(4), file: basePath }
      const renamedFinding = { ...finding(4), file: 'new.test.ts' }
      const rename = change({ renames: new Map([['new.test.ts', 'old.test.ts']]) })
      expect(
        ratchetDecision({ base: [baseFinding], head: [renamedFinding], change: rename }),
      ).toEqual([])
    },
  )

  test('a new file refuses every finding on its added lines', () => {
    const findings = [finding(1), finding(8, 'another finding')]
    expect(
      ratchetDecision({
        base: [],
        head: findings,
        change: change({
          addedLines: new Map([['example.test.ts', [{ start: 1, end: 12 }]]]),
        }),
      }),
    ).toEqual(findings.map((item) => ({ ...item, reason: 'added-line' })))
  })

  test('an unanalysed base refuses only findings on added lines and leaves other files normal', () => {
    const added = measured(20, 'added')
    const unchanged = { ...measured(30, 'existing'), line: 20 }
    const other = { ...measured(18, 'other'), file: 'other.ts' }
    expect(
      ratchetDecision({
        base: [measured(25, 'ignored'), { ...measured(16, 'other'), file: 'other.ts' }],
        head: [added, unchanged, other],
        change: change({ addedLines: new Map([['source.ts', [{ start: 10, end: 10 }]]]) }),
        unanalysedBase: new Set(['source.ts']),
      }),
    ).toEqual([
      { ...added, reason: 'added-line' },
      { ...other, reason: 'grew', previousMeasure: 16 },
    ])
  })
})
