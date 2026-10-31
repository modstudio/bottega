import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displayRunQuestion } from './question-display-probe.ts'

let runsDirectory: string
let priorRunsDirectory: string | undefined

beforeEach(() => {
  runsDirectory = mkdtempSync(join(tmpdir(), 'question-display-probe-'))
  priorRunsDirectory = process.env.BOTTEGA_RUNS
  process.env.BOTTEGA_RUNS = runsDirectory
})

afterEach(() => {
  if (priorRunsDirectory === undefined) delete process.env.BOTTEGA_RUNS
  else process.env.BOTTEGA_RUNS = priorRunsDirectory
  rmSync(runsDirectory, { recursive: true, force: true })
})

describe('run-question display probe', () => {
  test('locates references in scratch before artifacts', () => {
    const runDirectory = join(runsDirectory, 'run-live')
    mkdirSync(join(runDirectory, 'scratch'), { recursive: true })
    mkdirSync(join(runDirectory, 'artifacts'), { recursive: true })
    writeFileSync(join(runDirectory, 'scratch', 'report.json'), 'scratch')
    writeFileSync(join(runDirectory, 'artifacts', 'report.json'), 'artifacts')

    expect(displayRunQuestion('run-live', 'Read $BOTTEGA_SCRATCH/report.json')).toBe(
      `Read ${runDirectory}/scratch/report.json`,
    )
  })

  test('locates a retained reference in artifacts', () => {
    const runDirectory = join(runsDirectory, 'run-retained')
    mkdirSync(join(runDirectory, 'artifacts'), { recursive: true })
    writeFileSync(join(runDirectory, 'artifacts', 'report.json'), 'artifacts')

    expect(displayRunQuestion('run-retained', `Read ${runDirectory}/scratch/report.json`)).toBe(
      `Read ${runDirectory}/artifacts/report.json`,
    )
  })

  test('marks a missing reference gone only after the turn was collected', () => {
    const runDirectory = join(runsDirectory, 'run-collected')
    mkdirSync(join(runDirectory, 'artifacts'), { recursive: true })

    expect(displayRunQuestion('run-collected', `Read ${runDirectory}/scratch/report.json`)).toBe(
      `Read ${runDirectory}/scratch/report.json ` +
        `(not retained at turn end; see ${runDirectory}/artifacts/dropped.json)`,
    )
  })

  test.each([
    ['a live turn', true],
    ['an unavailable run', false],
  ])('leaves a missing reference unchanged for %s', (_name, createScratch) => {
    const runDirectory = join(runsDirectory, 'run-unknown')
    if (createScratch) mkdirSync(join(runDirectory, 'scratch'), { recursive: true })
    const question = `Read ${runDirectory}/scratch/report.json`

    expect(displayRunQuestion('run-unknown', question)).toBe(question)
  })
})
