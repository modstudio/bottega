import { expect, test } from 'bun:test'
import { serializeOutboxPayload } from './outbox-serialize.ts'

test('refuses the first nested NUL and reports its JSON path and remedy', () => {
  expect(() =>
    serializeOutboxPayload('run', [{ clean: 'value' }, { before: ' M file\0' }]),
  ).toThrow(
    'outbox run payload contains U+0000 at $[1].before; split or replace the separator before enqueue',
  )
})

test('refuses a NUL in an object key and reports its escaped JSON path', () => {
  expect(() => serializeOutboxPayload('question', { ['bad\0key']: 'value' })).toThrow(
    'outbox question payload contains U+0000 at $["bad\\u0000key"]',
  )
})

test('serializes a clean payload byte-for-byte like JSON.stringify', () => {
  const payload = { nested: [{ before: ' M file\n', after: '?? image.png\n' }], clean: true }
  expect(serializeOutboxPayload('run', payload)).toBe(JSON.stringify(payload))
})
