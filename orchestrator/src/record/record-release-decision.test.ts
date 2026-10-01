import { describe, expect, test } from 'bun:test'
import { decideRecordRelease } from './record-release-decision.ts'

describe('record release decision', () => {
  test('refuses when applied migrations are behind the image', () => {
    expect(decideRecordRelease(4, 5)).toEqual({ status: 'refuse', applied: 4, shipped: 5 })
  })

  test('passes when applied and shipped migrations match', () => {
    expect(decideRecordRelease(5, 5)).toEqual({ status: 'pass', applied: 5, shipped: 5 })
  })

  test('warns but passes when the schema is ahead of the image', () => {
    expect(decideRecordRelease(6, 5)).toEqual({ status: 'warn', applied: 6, shipped: 5 })
  })
})
