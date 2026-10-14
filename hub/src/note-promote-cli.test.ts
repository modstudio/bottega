import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { promotionTaskKey } from './note-promote-cli.ts'

describe('note promotion task option', () => {
  test('distinguishes an absent option from a bare or blank --task', () => {
    expect(promotionTaskKey(undefined, false)).toBeUndefined()
    expect(() => promotionTaskKey(undefined, true)).toThrow(
      `${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task <KEY>`,
    )
    expect(() => promotionTaskKey('  ', true)).toThrow(
      `${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task <KEY>`,
    )
    expect(promotionTaskKey('DEV-42', true)).toBe('DEV-42')
  })
})
