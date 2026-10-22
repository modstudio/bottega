import { describe, expect, test } from 'bun:test'
import { decideUnjudgedRunRemedy } from './unjudged-run-remedy.ts'

describe('unjudged run remedy', () => {
  test('voids unevidenced and other not-evidence failures', () => {
    expect(decideUnjudgedRunRemedy('unevidenced')).toBe('void')
    expect(decideUnjudgedRunRemedy('quota')).toBe('void')
  })

  test('scores judgeable failures and successful runs', () => {
    expect(decideUnjudgedRunRemedy('other')).toBe('score')
    expect(decideUnjudgedRunRemedy(null)).toBe('score')
  })
})
