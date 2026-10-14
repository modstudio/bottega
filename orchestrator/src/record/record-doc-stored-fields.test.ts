import { expect, test } from 'bun:test'
import { storedDocDelivery } from './record-doc-stored-fields.ts'

test('omitted delivery keeps the stored value', () => {
  expect(storedDocDelivery({}, { delivery: 'demand' })).toBe('demand')
})

test('explicit delivery wins over the stored value', () => {
  expect(storedDocDelivery({ delivery: 'inject' }, { delivery: 'demand' })).toBe('inject')
})

test('new documents default delivery to inject', () => {
  expect(storedDocDelivery({})).toBe('inject')
})
