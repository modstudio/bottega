import { expect, test } from 'bun:test'
import { checkoutConfinementFailure } from './check-checkout-cli-confinement.ts'

test('classifies only package failures and host-present relative imports as confinement failures', () => {
  expect(
    checkoutConfinementFailure(
      "Cannot find package 'missing-package' imported from /repo/main.ts",
      () => false,
    ),
  ).toEqual({
    kind: 'package-resolution',
    match: "Cannot find package 'missing-package'",
  })

  const relativeError =
    "Cannot find module '../../typos.toml' imported from /repo/shared/prose/spelling-lists.ts"
  expect(
    checkoutConfinementFailure(relativeError, (specifier, importer) => {
      expect(specifier).toBe('../../typos.toml')
      expect(importer).toBe('/repo/shared/prose/spelling-lists.ts')
      return true
    }),
  ).toEqual({
    kind: 'hidden-relative-import',
    match: relativeError,
    specifier: '../../typos.toml',
    importer: '/repo/shared/prose/spelling-lists.ts',
  })

  expect(checkoutConfinementFailure(relativeError, () => false)).toBeNull()
  expect(checkoutConfinementFailure('ask server closed before tools/list', () => true)).toBeNull()
})
