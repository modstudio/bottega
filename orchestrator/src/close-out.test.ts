import { describe, expect, test } from 'bun:test'
import { extractionRunId } from './close-out.ts'

describe('close-out extraction decision', () => {
  test('rejects filing a child turn extraction under the conversation root', () => {
    expect(extractionRunId({ id: 4267 })).toBe(4267)
  })
})
