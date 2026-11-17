import { describe, expect, test } from 'bun:test'
import {
  mainCheckoutInvariant,
  returnMainCheckoutToTrunkCommand,
} from './main-checkout-invariant.ts'

test('renders the sanctioned return-to-trunk command', () => {
  expect(returnMainCheckoutToTrunkCommand('/projects/example', 'main')).toBe(
    "git -C '/projects/example' switch 'main'",
  )
  expect(returnMainCheckoutToTrunkCommand("/projects/it's here", 'main;touch x')).toBe(
    "git -C '/projects/it'\\''s here' switch 'main;touch x'",
  )
})

describe('main checkout invariant', () => {
  test('holds only on trunk without tracked modifications', () => {
    expect(
      mainCheckoutInvariant('/projects/example', {
        branch: 'main',
        trunk: 'main',
        trackedModified: false,
      }),
    ).toEqual({ holds: true })
  })

  test('refuses an off-trunk or tracked-dirty checkout', () => {
    expect(
      mainCheckoutInvariant('/projects/example', {
        branch: 'release',
        trunk: 'main',
        trackedModified: false,
      }),
    ).toMatchObject({ holds: false })
    expect(
      mainCheckoutInvariant('/projects/example', {
        branch: 'main',
        trunk: 'main',
        trackedModified: true,
      }),
    ).toMatchObject({ holds: false })
  })
})
