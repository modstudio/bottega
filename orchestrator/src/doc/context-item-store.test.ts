import { expect, test } from 'bun:test'
import { contextItemReadFailure, contextItemReadSource } from './context-item-store.ts'

test('context-item reads select the install authority without fallback', () => {
  expect(contextItemReadSource({ verdict: 'local-authoritative' })).toBe('local')
  expect(contextItemReadSource({ verdict: 'hosted' })).toBe('hosted')
  expect(() =>
    contextItemReadSource({
      verdict: 'refused',
      refusal: 'record binding is unresolved',
      boundOrigin: null,
      resolvedOrigin: 'https://record.example.test',
    }),
  ).toThrow('record binding is unresolved')
})

test('an unreachable hosted context-item read refuses with a remedy', () => {
  expect(() => contextItemReadFailure(new Error('record API 404'))).toThrow(
    /hosted context items could not be read \(record API 404\)[\s\S]*remedy: run `bottega record doctor`/,
  )
})
