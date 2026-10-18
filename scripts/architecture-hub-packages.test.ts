import { expect, test } from 'bun:test'
import {
  hubUtilArchitectureRules,
  hubUtilRuntimeDependencyViolations,
} from './architecture-hub-packages.ts'

const utilRule = hubUtilArchitectureRules()[0]

function utilImportIsAllowed(target: string) {
  return utilRule.to.pathNot.some((pattern) => new RegExp(pattern).test(target))
}

test('hub util imports only its own modules and shared modules', () => {
  expect(utilImportIsAllowed('hub/util/src/format.ts')).toBeTrue()
  expect(utilImportIsAllowed('shared/brand.ts')).toBeTrue()
  expect(utilImportIsAllowed('@codemirror/view')).toBeFalse()
  expect(utilImportIsAllowed('node:fs')).toBeFalse()
})

test('hub util refuses declared runtime dependencies', () => {
  expect(hubUtilRuntimeDependencyViolations({ dependencies: { zod: '^4.0.0' } })).toContain(
    'hub/util/package.json: dependencies may not declare zod',
  )
  expect(
    hubUtilRuntimeDependencyViolations({
      peerDependencies: { react: '^19.0.0' },
      dependencies: undefined,
    }),
  ).toContain('hub/util/package.json: peerDependencies may not declare react')
  expect(hubUtilRuntimeDependencyViolations({})).toEqual([])
})
