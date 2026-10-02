import { describe, expect, test } from 'bun:test'
import { promotionTaskKey } from './note-promote-cli.ts'

describe('note promotion task option', () => {
  test('distinguishes an absent option from a bare or blank --task', () => {
    expect(promotionTaskKey(undefined, false)).toBeUndefined()
    expect(() => promotionTaskKey(undefined, true)).toThrow('hub note promote <ID> --task <KEY>')
    expect(() => promotionTaskKey('  ', true)).toThrow('hub note promote <ID> --task <KEY>')
    expect(promotionTaskKey('DEV-42', true)).toBe('DEV-42')
  })
})
