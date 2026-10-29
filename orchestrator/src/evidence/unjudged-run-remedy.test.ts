import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideUnjudgedRunRemedy, renderUnjudgedRunRemedy } from './unjudged-run-remedy.ts'

describe('unjudged run remedy', () => {
  test('voids unevidenced and other not-evidence failures', () => {
    expect(decideUnjudgedRunRemedy('unevidenced', 'codex')).toBe('void')
    expect(decideUnjudgedRunRemedy('quota', 'codex')).toBe('void')
  })

  test('voids a stopped run whose agent was never resolved', () => {
    expect(decideUnjudgedRunRemedy('stopped', '(pending)')).toBe('void')
  })

  test('scores a stopped run whose agent was resolved', () => {
    expect(decideUnjudgedRunRemedy('stopped', 'codex')).toBe('score')
  })

  test('scores judgeable failures and successful runs', () => {
    expect(decideUnjudgedRunRemedy('other', 'codex')).toBe('score')
    expect(decideUnjudgedRunRemedy(null, 'codex')).toBe('score')
  })

  test('renders the clearing command for a run number or placeholder', () => {
    expect(renderUnjudgedRunRemedy('score', 42)).toBe(`${PLATFORM_SLUG} score 42 none`)
    expect(renderUnjudgedRunRemedy('void', '<n>')).toBe(
      `${PLATFORM_SLUG} score <n> none --void --note "<why>"`,
    )
  })
})
