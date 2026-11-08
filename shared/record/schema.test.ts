import { expect, spyOn, test } from 'bun:test'
import { newRecordId, recordJsonbValue, space } from './schema.ts'

test('space metadata normalizes stringified JSON without changing objects', () => {
  const metadata = { trial: { createdByUserId: 'caller' } }
  expect(recordJsonbValue(JSON.stringify(metadata))).toEqual(metadata)
  expect(recordJsonbValue(metadata)).toBe(metadata)
  expect(space.metadata.mapToDriverValue(JSON.stringify(metadata))).toEqual(metadata)
  expect(space.metadata.mapFromDriverValue(JSON.stringify(metadata))).toEqual(metadata)
})

function nextUuid(id: string): string {
  const digits = [...id]
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] === '-') continue
    const value = Number.parseInt(digits[index]!, 16)
    if (value < 15) {
      digits[index] = (value + 1).toString(16)
      return digits.join('')
    }
    digits[index] = '0'
  }
  throw new Error(`cannot increment UUID ${id}`)
}

test('newRecordId is strictly increasing and unique in a tight loop', () => {
  const ids = Array.from({ length: 10_000 }, () => newRecordId())
  expect(new Set(ids).size).toBe(ids.length)
  for (let index = 1; index < ids.length; index++) expect(ids[index]! > ids[index - 1]!).toBeTrue()
})

test('newRecordId retries after Bun UUIDv7 counter rollover', () => {
  const previous = newRecordId()
  const next = nextUuid(previous)
  const candidates = [previous, next]
  const random = spyOn(Bun, 'randomUUIDv7').mockImplementation(
    (() => candidates.shift()!) as typeof Bun.randomUUIDv7,
  )
  try {
    expect(newRecordId()).toBe(next)
    expect(random).toHaveBeenCalledTimes(2)
  } finally {
    random.mockRestore()
  }
})
