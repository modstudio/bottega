import { expect, test } from 'bun:test'
import { assertRecordLensVersion, RecordLensError } from './record-lens-catalogue.ts'

test('lens catalogue compare-and-set refuses a stale version', () => {
  expect(() => assertRecordLensVersion('lens', 2, 3)).toThrow(
    'refusing stale lens update: expected version 2, current version 3',
  )
  try {
    assertRecordLensVersion('lens', 2, 3)
  } catch (error) {
    expect(error).toBeInstanceOf(RecordLensError)
    expect((error as RecordLensError).status).toBe(409)
  }
})
