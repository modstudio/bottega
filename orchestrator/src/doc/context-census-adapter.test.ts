import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assertCensusProjectRegistered } from './context-census-adapter.ts'

describe('context census adapter', () => {
  test('refuses an unregistered project filter with the register remedy', () => {
    expect(() => assertCensusProjectRegistered('missing', [{ name: PLATFORM_SLUG }])).toThrow(
      `unknown project missing; run ${PLATFORM_SLUG} project list --json`,
    )
    expect(() =>
      assertCensusProjectRegistered(PLATFORM_SLUG, [{ name: PLATFORM_SLUG }]),
    ).not.toThrow()
  })
})
