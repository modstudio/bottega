import { describe, expect, test } from 'bun:test'
import { mainCheckoutInvariant } from './main-checkout-invariant.ts'

describe('main checkout invariant', () => {
  test('holds only on trunk without tracked modifications', () => {
    expect(
      mainCheckoutInvariant({ branch: 'main', trunk: 'main', trackedModified: false }),
    ).toEqual({ holds: true })
  })

  test('refuses an off-trunk or tracked-dirty checkout', () => {
    expect(
      mainCheckoutInvariant({ branch: 'release', trunk: 'main', trackedModified: false }),
    ).toMatchObject({ holds: false })
    expect(
      mainCheckoutInvariant({ branch: 'main', trunk: 'main', trackedModified: true }),
    ).toMatchObject({ holds: false })
  })
})
