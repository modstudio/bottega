import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { mainCheckoutInvariant } from './main-checkout-invariant.ts'

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
    expect(
      mainCheckoutInvariant('/projects/example', {
        branch: 'release',
        trunk: 'main',
        trackedModified: true,
      }),
    ).toEqual({
      holds: false,
      message: `checkout branch is release, not landing branch main; checkout has tracked modifications; restore the tracked checkout, then run git -C '/projects/example' switch 'main', then run ${PLATFORM_SLUG} machine doctor`,
    })
  })
})
