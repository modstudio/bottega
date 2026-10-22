import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideUnjudgedRunRemedy, renderUnjudgedRunRemedy } from './unjudged-run-remedy.ts'

describe('unjudged run remedy', () => {
  test('voids unevidenced and other not-evidence failures', () => {
    expect(decideUnjudgedRunRemedy('unevidenced')).toBe('void')
    expect(decideUnjudgedRunRemedy('quota')).toBe('void')
  })

  test('scores judgeable failures and successful runs', () => {
    expect(decideUnjudgedRunRemedy('other')).toBe('score')
    expect(decideUnjudgedRunRemedy(null)).toBe('score')
  })

  test('renders the clearing command for a run number or placeholder', () => {
    expect(renderUnjudgedRunRemedy('score', 42)).toBe(`${PLATFORM_SLUG} score 42`)
    expect(renderUnjudgedRunRemedy('void', '<n>')).toBe(
      `${PLATFORM_SLUG} score <n> none --void --note "<why>"`,
    )
  })
})
