import { expect, test } from 'bun:test'
import { refusal } from '../../shared/refusal.ts'
import { RefusalError } from './refusal-error.ts'

test('a refusal error carries the structured refusal it renders', () => {
  const detail = refusal('cannot continue', { kind: 'edit', text: 'repair the declaration' })
  const error = new RefusalError(detail)

  expect(error.refusalDetail).toBe(detail)
  expect(error.message).toBe('cannot continue\ncleared by: repair the declaration')
})
